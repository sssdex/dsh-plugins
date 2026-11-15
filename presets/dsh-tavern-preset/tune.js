/**
 * 酒馆预设的「思考减负器」。
 *
 * 角色扮演和代码任务不一样：扮演要的是「立刻按角色说话」，不是推演。
 * 实测（本机 25,750 步）思考占全部生成 token 的 66.5%，可见文字只占 2.8%；
 * 扮演场景里这个比例只会更极端 —— 推理档位拉满是纯浪费，还会让回复变慢、
 * 变得像在分析角色而不是成为角色。
 *
 * 三个安全边界（照搬 sprint/tune.js，已实机验证）：
 *   1. 先查该路由真实支持的 reasoning.efforts，不在列表里就不动；
 *   2. 查不到（适配器不报能力）也按不动处理；
 *   3. 只降不升：当前已经是更低的档位时保持原样。
 *
 * agent.model.select() 只影响下一次尚未开始的步骤（它写一条 model/selection 事件），
 * 所以在 agent/created 时设定不会打断任何进行中的回合。
 */

export const inject = ['llm']
export const name = 'tavern-tune'

/**
 * 不要导出 Config。理由见 restrict.js 里那段注释（schemastery 事故）。
 * 取值校验放在 apply() 里做，等价且零依赖。
 */

/** 本预设允许的档位。其余值一律不动作，交给用户在界面上的选择。 */
const EFFORTS = new Set(['none', 'minimal', 'low', 'high'])

/** 由低到高的档位次序，用于「只降不升」。 */
const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'max']

/**
 * 该模型是否声明支持某档推理强度。
 * @returns true=支持 / false=明确不支持 / null=适配器未报能力
 */
async function supports(ctx, provider, model, effort) {
  let meta
  try {
    // llm 服务上的方法叫 resolveModelInfo，不是 resolveModel（后者是 adapter 内部
    // 方法）。写成 resolveModel 会一直抛 TypeError 被 catch 吃掉，表现为
    // 「预设装好了但推理强度从来没变过」。
    meta = await ctx.llm.resolveModelInfo(provider, model)
  } catch {
    return null
  }
  const efforts = meta?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return null
  const ids = efforts.map(e => (typeof e === 'string' ? e : e?.id)).filter(Boolean)
  if (ids.length === 0) return null
  return ids.includes(effort)
}

export function apply(ctx, config) {
  const target = config?.reasoningEffort
  if (!EFFORTS.has(target)) return

  const warn = (message) => {
    try {
      ctx.logger('tavern-tune').warn(message)
    } catch {
      // logger 不可用就放弃记录。
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    try {
      const current = agent.model.current?.()
      if (current?.provider === undefined || current?.model === undefined) return

      const now = ORDER.indexOf(current.reasoningEffort ?? '')
      const want = ORDER.indexOf(target)
      if (now !== -1 && now <= want) return

      const ok = await supports(ctx, current.provider, current.model, target)
      if (ok !== true) {
        warn(`无法确认 ${current.provider}/${current.model} 支持 ${target}，保持原档位`)
        return
      }

      agent.model.select({
        provider: current.provider,
        model: current.model,
        reasoningEffort: target,
      })
    } catch (error) {
      warn(`设置推理档位 ${target} 失败: ${error?.message ?? error}`)
    }
  })
}
