/**
 * file-fast 预设的「思考减负器」。
 *
 * 实测依据（本机 254 个历史会话 / 5002 个 step）：
 *   思考长度与本步模型耗时的相关系数 0.937，几乎线性：
 *     几乎不想考 3.2s ／ 小 4.8s ／ 中 7.4s ／ 大 10.3s ／ 超大 15.5s
 *   而写文件本身（write/edit/read）只要 9~32ms。
 *   一个 22 步的改文件会话：工具执行 19s，模型思考 632s —— 97% 的时间在等思考。
 *
 * preset 改不了模型，但 agent 在本预设里创建，可以在 agent/created 那一刻
 * 把推理强度按本预设的取向调低。agent.model.select() 只对下一次尚未开始的
 * 步骤生效，创建时设定不会打断任何进行中的回合。
 *
 * 安全边界：
 *   - 先查该路由真实支持的 reasoning.efforts，不在列表里就不动；
 *   - 查不到（适配器不报能力）也按不动处理，宁可慢也不要把会话搞坏；
 *   - 只降不升：当前已经是更低的档位时保持原样。
 */

export const inject = ['llm'];
export const name = 'file-fast-tune';

/**
 * 这里**不要**导出 Config。
 *
 * cordis 的 plugin.Config 必须是 StandardSchemaV1（带 `~standard.validate`）。
 * 本包是 link 安装、目录下没有 node_modules，import 不到
 * `@deepseek-ai/schemastery`，所以也不能用 z.object() 写。
 *
 * 2026-11-11 的故障：这里曾写了一个 schemastery 的 JSON 描述字面量
 * （type:'union' + dict），cordis 把它当 schema 去调 `.validate`，
 * 结果整个预设报「Cannot read properties of undefined (reading 'validate')」，
 * 两条预设行一起挂掉。取值校验改在 apply() 里做，等价且零依赖。
 */
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
    // 注意：llm 服务上的方法叫 resolveModelInfo，不是 resolveModel
    // （resolveModel 是 adapter 内部的方法）。写成 resolveModel 会一直抛
    // TypeError 被下面的 catch 吃掉，表现为「预设装好了但推理强度没变」。
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
      ctx.logger('file-fast-tune').warn(message);
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
        // 所以留一条 trace，便于和「该模型确实不支持 low」区分开。
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
