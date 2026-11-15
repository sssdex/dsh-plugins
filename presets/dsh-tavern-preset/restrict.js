/**
 * 酒馆预设的工具收窄器。
 *
 * 目的只有一个：让扮演预设的每步 prefill 里只剩下「真正会用到的工具」。
 * 宿主平面在本机注册了 70+ 个工具（cg / ego_* / mcp__* / remote_* / image-gen /
 * meme / team_task_* / schedule_* …），扮演一次对话一个都用不上，却每步都付 schema。
 *
 * 做法与 sprint / file-fast 一致：维护 KEEP 白名单，其余全部 deny。
 * 为什么用 deny 不用 allow：dsh-tools 的 ToolLayer.admits() 取交集，
 * allow 反复施加会越收越窄，deny 反复施加是并集，天然可累积、幂等安全。
 *
 * 两道幂等闸（applying + lastDenyKey）缺一不可：restrict() 自身会触发
 * tools/change，而本插件就在 tools/change 上重跑 → 无出口微任务循环 →
 * host 满核空转。file-fast 2026-11-11 实机踩过。
 */

/** 扮演预设保留的工具面。改这里就是改这个预设的能力边界。 */
const KEEP_PLAY = new Set([
  'read',              // 读 card.md / state.json / chat.jsonl
  'write',             // 整文件重写 state.json / chat.jsonl
  'edit',              // 局部改 state.json，比重写省 token
  'glob',              // 按卡名找 cards/ 下的目录
  'grep',              // 在 chat.jsonl 里回查历史细节
  'read_image',        // 人物卡立绘、用户贴图
  'ask_user_question', // 选卡 / 确认重置这类一次性选择
])

/**
 * 备卡预设保留的工具面。多一个 pwsh —— 解析 PNG 卡必须跑脚本。
 * 备卡是低频一次性动作，多这 833 tok 可以接受。
 */
const KEEP_PREP = new Set([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'read_image',
  'pwsh',
  'bash',
  'job_output',
  'job_list',
  'job_kill',
  'ask_user_question',
])

/**
 * restrict() 明确拒绝点名的保留名（PTC 传输层）。dsh-tools 源码里写死
 * `[...allow, ...deny].includes("run_code")` 直接 throw。
 */
const RESERVED = new Set(['run_code'])

export const inject = ['tools']
export const name = 'tavern-restrict'

/** 每个 profile 实例一份状态，避免两个预设共用一个闸。 */
const state = new WeakMap()

function stateOf(ctx) {
  let s = state.get(ctx)
  if (!s) {
    s = { applying: false, lastDenyKey: '' }
    state.set(ctx, s)
  }
  return s
}

/**
 * 把当前已知且不在保留清单里的工具全部 deny 掉。
 *
 * 取 ctx.tools.view(undefined) 的 knownNames：view(scope) 的 restrictableNames
 * 只包含 inherited，而 view(undefined) 的 inherited 从全局层起步，所以「取全局视图
 * 的名字」永远不会触发 restrict() 的 "unknown global tool" 整批拒绝。
 * 代价：作用域链上祖先层注册、不在全局层的工具挡不掉（已知、可接受）。
 */
function denyTheRest(ctx, keep, warn) {
  const s = stateOf(ctx)
  let known
  try {
    const view = ctx.tools.view(undefined)
    known = view?.knownNames
    if (!(known instanceof Set)) throw new TypeError('view(undefined).knownNames 不可用')
  } catch (error) {
    warn?.(`读取工具清单失败: ${error?.message ?? error}`)
    return 0
  }

  const deny = []
  for (const toolName of known) {
    if (keep.has(toolName) || RESERVED.has(toolName)) continue
    deny.push(toolName)
  }
  if (deny.length === 0) return 0

  const key = [...deny].sort().join('\n')
  if (key === s.lastDenyKey) return 0
  if (s.applying) return 0

  s.applying = true
  try {
    ctx.tools.restrict({ deny })
    s.lastDenyKey = key
    return deny.length
  } catch (error) {
    warn?.(`restrict() 被拒绝: ${error?.message ?? error}`)
    return 0
  } finally {
    s.applying = false
  }
}

/**
 * 不导出 Config。
 *
 * cordis 的 plugin.Config 必须是 StandardSchemaV1（带 `~standard.validate`）。
 * 本包是 link 安装、目录下没有 node_modules，import 不到 @deepseek-ai/schemastery，
 * 写不出 z.object()。2026-11-11 的故障：file-fast 的 tune.js 曾用 schemastery 的
 * JSON 描述字面量当 Config，cordis 拿它去调 .validate，整个预设报
 * 「Cannot read properties of undefined (reading 'validate')」，两条预设行一起挂掉。
 * 取值校验改在 apply() 里做，等价且零依赖。
 */
export function apply(ctx, config) {
  const mode = config?.mode === 'prep' ? 'prep' : 'play'
  const keep = mode === 'prep' ? KEEP_PREP : KEEP_PLAY

  const warn = (message) => {
    try {
      ctx.logger('tavern-restrict').warn(message)
    } catch {
      // logger 不可用就算了，不要因为打日志把预设搞挂。
    }
  }

  denyTheRest(ctx, keep, warn)
  // 后注册的工具（MCP 服务器、全局插件）在这里被挡在模型视野之外。
  ctx.on('tools/change', () => {
    denyTheRest(ctx, keep, warn)
  })
}
