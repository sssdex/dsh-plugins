/**
 * 冲刺·sprint 预设的「思考减负器」。
 *
 * ──── 为什么要有这一层 ────────────────────────────────────────────────────
 * 本机 25,750 步实测：
 *   - 思考（reasoning）占全部生成 token 的 66.5%，可见文字只占 2.8%；
 *   - 思考 >5000 字符的步只占 10.8%，却吃掉 45.9% 的 decode 时间；
 *   - 把这些大思考步压到中位 → decode 总量 −35%。
 *   - 档位中位思考字符：max 552 / high 363 / low 506。
 *
 * 注意 high→low 的中位数并不是单调的（506 > 363），说明**单看中位会骗人**：
 * 真正有差别的是尾部（max 档 p90 明显更肥）。这一层是低置信度的收益，
 * 所以做成「查不到能力就不动」，宁可慢也不要把会话搞坏。
 *
 * ──── 三个安全边界 ────────────────────────────────────────────────────────
 *   1. 先查该路由真实支持的 reasoning.efforts，不在列表里就不动；
 *   2. 查不到（适配器不报能力）也按不动处理；
 *   3. 只降不升：当前已经是更低的档位时保持原样。
 *
 * agent.model.select() 只影响下一次尚未开始的步骤（它写一条 model/selection 事件），
 * 所以在 agent/created 时设定不会打断任何进行中的回合。
 */

export const inject = ['llm'];
export const name = 'sprint-tune';

/**
 * 这里**绝对不要**导出 Config。
 *
 * cordis 的 plugin.Config 必须是 StandardSchemaV1（带 `~standard.validate`）。
 * 本包是 link 安装、目录下没有 node_modules，import 不到
 * `@deepseek-ai/schemastery`，所以也写不出 z.object()。
 *
 * 2026-11-11 的故障：file-fast 的 tune.js 曾写了一个 schemastery 的 JSON 描述字面量
 * 当 Config，cordis 把它当 schema 去调 `.validate`，结果整个预设报
 * 「Cannot read properties of undefined (reading 'validate')」，两条预设行一起挂掉。
 *
 * 取值校验改在 apply() 里做，等价且零依赖。
 */

/** 本预设允许的档位。其余值一律不动作，交给用户在界面上的选择。 */
const EFFORTS = new Set(['low', 'high']);

/** 由低到高的档位次序，用于「只降不升」。 */
const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'max'];

/**
 * 该模型是否声明支持某档推理强度。
 * @returns true=支持 / false=明确不支持 / null=适配器未报能力
 */
async function supports(ctx, provider, model, effort) {
  let meta;
  try {
    // 注意：llm 服务上的方法叫 resolveModelInfo(provider, model, signal)，
    // 不是 resolveModel —— 后者是 adapter 内部的方法（llm 里是
    // registration.adapter.resolveModel）。写成 resolveModel 会一直抛
    // TypeError 被下面的 catch 吃掉，表现为「预设装好了但推理强度从来没变过」。
    meta = await ctx.llm.resolveModelInfo(provider, model);
  } catch {
    return null;
  }
  const efforts = meta?.reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return null;
  const ids = efforts.map(e => (typeof e === 'string' ? e : e?.id)).filter(Boolean);
  if (ids.length === 0) return null;
  return ids.includes(effort);
}

export function apply(ctx, config) {
  // Config 取值校验（原来靠 Config schema 做，现在在这里做）。
  // unset / 非法值 → 什么都不做，交给用户在界面上的选择。
  const target = config?.reasoningEffort;
  if (!EFFORTS.has(target)) return;

  // 打日志本身绝不能把预设搞挂，所以整条链路都包住。
  const warn = (message) => {
    try {
      ctx.logger('sprint-tune').warn(message);
    } catch {
      // logger 不可用就放弃记录。
    }
  };

  ctx.on('agent/created', async ({ agent }) => {
    try {
      const current = agent.model.current?.();
      if (current?.provider === undefined || current?.model === undefined) return;

      // 已经在这个档或更低：不动。
      const now = ORDER.indexOf(current.reasoningEffort ?? '');
      const want = ORDER.indexOf(target);
      if (now !== -1 && now <= want) return;

      const ok = await supports(ctx, current.provider, current.model, target);
      if (ok !== true) {
        // 查不到能力 ≠ 出错，但「一直是 null」正是上次 resolveModel 写错时的表现，
        // 所以留一条 warn，便于和「该模型确实不支持 low」区分开。
        warn(`无法确认 ${current.provider}/${current.model} 支持 ${target}，保持原档位`);
        return;
      }

      agent.model.select({
        provider: current.provider,
        model: current.model,
        reasoningEffort: target,
      });
    } catch (error) {
      // 路由拒绝该档位/适配器未就绪：保持默认，不影响会话。
      warn(`降档到 ${target} 失败: ${error?.message ?? error}`);
    }
  });
}
