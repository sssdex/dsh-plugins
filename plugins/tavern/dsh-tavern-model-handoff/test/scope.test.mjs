/**
 * 「仅对酒馆 preset 生效」的穷举验收。
 * `node test/scope.test.mjs`
 *
 * 为什么单独一个文件：apply() 里的 presetOf() 是四路兜底 + ctx.get('agentPresets')，
 * 光看代码读不出「哪些预设会被接管」。这里把本 profile **实际存在的全部 preset id**
 * 硬编码进来，逐个断言 —— 只有 tavern-play 允许 select，其余一个字节都不许动。
 *
 * 这 8 个 id 来自实测扫描（2026-11-12，profile 的 package.json bundles + 各自
 * dsh.bundle.patch）：
 *   fast-solver / file-fast / lean / sprint / sprint-high / super-code /
 *   tavern-play / tavern-prep
 * 外加 standard（registry 的 default）与两个不该命中的近名 id。
 */

let pass = 0
let fail = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) pass++
  else {
    fail++
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * 本 profile 实测存在的全部 preset id（源：2026-11-12 扫描 profile patch +
 * 每个 bundle 的 dsh.bundle.patch；官方内置三个直接读 app.asar 里的
 * dsh-web-app/presets/*.patch.yml 确认）。
 *
 * 说明：`dsh-tavern`（tgz 安装）在本 profile 只注册 profile-bridge 这个
 * launcher 行，**不声明任何预设**，所以官方「酒馆模式」tavern / tavern-background
 * 不在此 profile 的预设表里（它们在 tavern profile）。
 * 仍把它们列进 SHOULD_NOT_MATCH 做防御性断言。
 */
const REAL_PRESETS = [
  // 官方内置
  'standard',
  'minimal',
  'ptc',
  // 本 profile 自定义
  'fast-solver',
  'file-fast',
  'lean',
  'sprint',
  'sprint-high',
  'super-code',
  'tavern-play',
  'tavern-prep',
]

/** 允许被接管的（有且仅有一个）。 */
const SHOULD_MATCH = new Set(['tavern-play'])

/** 建假 ctx。`presetVia` 模拟预设身份从哪一路取到。 */
function makeCtx({ presetVia = 'composed', presetValue, efforts = [{ id: 'off' }], noRegistry = false } = {}) {
  const hooks = new Map()
  const logs = []
  const ctx = {
    logger: () => ({
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
    on(name, listener, opts) {
      const hook = { listener, prepend: opts === true || opts?.prepend === true }
      const list = hooks.get(name) ?? []
      if (hook.prepend) list.unshift(hook)
      else list.push(hook)
      hooks.set(name, list)
      let live = true
      return () => {
        if (!live) return false
        live = false
        const idx = list.indexOf(hook)
        if (idx >= 0) list.splice(idx, 1)
        return true
      }
    },
    get(name) {
      if (noRegistry || name !== 'agentPresets') return undefined
      return {
        composedPreset: () => (presetVia === 'composed' ? presetValue : undefined),
        presetForSession: () => (presetVia === 'projection' ? presetValue : undefined),
      }
    },
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts } }) },
  }
  const emit = async (name, ...payload) => {
    for (const hook of [...(hooks.get(name) ?? [])]) await hook.listener(...payload)
  }
  return { ctx, logs, emit }
}

function makeAgent(id, { headerPreset, logPreset, presetVia } = {}) {
  const state = {
    id,
    appending: false,
    eventLog: [],
    selections: [],
  }
  if (logPreset !== undefined) state.eventLog.push({ type: 'agent-preset/selected', data: { agentPreset: logPreset } })
  const session = {
    id,
    header: headerPreset === undefined ? {} : { agentPreset: headerPreset },
    snapshotEvents: (from = 0) => state.eventLog.slice(from),
    append(type, data) {
      if (state.appending) throw new Error('session append cannot reenter while another append is being published')
      state.eventLog.push({ type, data })
    },
  }
  const model = {
    _current: { provider: 'workbuddy-global', model: 'hy3', reasoningEffort: 'high' },
    current: () => ({ ...model._current }),
    select(selection) {
      session.append('model/selection', selection)
      model._current = { ...selection }
      state.selections.push({ ...selection })
    },
  }
  return { agent: { id, session, ctx: { presetVia }, model }, state }
}

const { apply } = await import('../index.js')

// ───────────────────────────────────────────────────────────────────────────
// [A] 走 composedPreset（正常路径）：全部真实 preset 逐个跑
// ───────────────────────────────────────────────────────────────────────────
for (const preset of REAL_PRESETS) {
  const { ctx, emit } = makeCtx({ presetValue: preset })
  apply(ctx, {})
  const { agent, state } = makeAgent(`sess-${preset}`, { presetVia: 'composed' })
  await emit('agent/created', { agent, source: 'fresh' })

  if (SHOULD_MATCH.has(preset)) {
    ok(`[A] ${preset} 应被接管`, state.selections.length === 1 && state.selections[0].provider === 'zzz1', JSON.stringify(state.selections))
  } else {
    ok(`[A] ${preset} 不应被接管`, state.selections.length === 0, JSON.stringify(state.selections))
  }
}

// ───────────────────────────────────────────────────────────────────────────
// [B] 走 presetForSession 投影
// ───────────────────────────────────────────────────────────────────────────
for (const preset of REAL_PRESETS) {
  const { ctx, emit } = makeCtx({ presetVia: 'projection', presetValue: preset })
  apply(ctx, {})
  const { agent, state } = makeAgent(`proj-${preset}`, { presetVia: 'projection' })
  await emit('agent/created', { agent, source: 'fresh' })
  const expected = SHOULD_MATCH.has(preset) ? 1 : 0
  ok(`[B] 投影路径 ${preset} → ${expected} 次 select`, state.selections.length === expected, JSON.stringify(state.selections))
}

// ───────────────────────────────────────────────────────────────────────────
// [C] 注册表整个拿不到（noRegistry）→ 退回 header / 日志兜底
// ───────────────────────────────────────────────────────────────────────────
for (const preset of REAL_PRESETS) {
  const { ctx, emit } = makeCtx({ noRegistry: true })
  apply(ctx, {})
  const { agent, state } = makeAgent(`hdr-${preset}`, { headerPreset: preset })
  await emit('agent/created', { agent, source: 'fresh' })
  const expected = SHOULD_MATCH.has(preset) ? 1 : 0
  ok(`[C] header 兜底 ${preset} → ${expected} 次 select`, state.selections.length === expected, JSON.stringify(state.selections))
}

// 日志兜底（header 也没有，只剩 agent-preset/selected 事件）
{
  const { ctx, emit } = makeCtx({ noRegistry: true })
  apply(ctx, {})
  const { agent, state } = makeAgent('log-play', { logPreset: 'tavern-play' })
  await emit('agent/created', { agent, source: 'fresh' })
  ok('[C] 日志兜底 tavern-play 被接管', state.selections.length === 1)
}
{
  const { ctx, emit } = makeCtx({ noRegistry: true })
  apply(ctx, {})
  const { agent, state } = makeAgent('log-sprint', { logPreset: 'sprint' })
  await emit('agent/created', { agent, source: 'fresh' })
  ok('[C] 日志兜底 sprint 不被接管', state.selections.length === 0)
}

// ───────────────────────────────────────────────────────────────────────────
// [D] 身份完全查不到 → 必须保守不动
// ───────────────────────────────────────────────────────────────────────────
{
  const { ctx, emit } = makeCtx({ noRegistry: true })
  apply(ctx, {})
  const { agent, state } = makeAgent('unknown', {})
  await emit('agent/created', { agent, source: 'fresh' })
  ok('[D] 身份未知时不接管（宁可失效不误伤）', state.selections.length === 0, JSON.stringify(state.selections))
}

// ───────────────────────────────────────────────────────────────────────────
// [E] 近名 id 不得被宽松匹配
// ───────────────────────────────────────────────────────────────────────────
for (const near of ['tavern', 'tavern-play-2', 'tavern_play', 'Tavern-Play', 'tavern-play ', ' tavern-play', 'tavern-background']) {
  const { ctx, emit } = makeCtx({ presetValue: near })
  apply(ctx, {})
  const { agent, state } = makeAgent(`near-${near}`, { presetVia: 'composed' })
  await emit('agent/created', { agent, source: 'fresh' })
  ok(`[E] 近名 "${near}" 不匹配`, state.selections.length === 0, JSON.stringify(state.selections))
}

// ───────────────────────────────────────────────────────────────────────────
// [F] 配置成多个预设时，只认名单里的；名单外仍然不动
// ───────────────────────────────────────────────────────────────────────────
{
  const { ctx, emit } = makeCtx({ presetValue: 'tavern' })
  apply(ctx, { presets: ['tavern-play', 'tavern'] })
  const { agent, state } = makeAgent('multi-1', { presetVia: 'composed' })
  await emit('agent/created', { agent, source: 'fresh' })
  ok('[F] 显式加进名单的 tavern 会被接管', state.selections.length === 1)
}
{
  const { ctx, emit } = makeCtx({ presetValue: 'sprint' })
  apply(ctx, { presets: ['tavern-play', 'tavern'] })
  const { agent, state } = makeAgent('multi-2', { presetVia: 'composed' })
  await emit('agent/created', { agent, source: 'fresh' })
  ok('[F] 名单外的 sprint 仍不接管', state.selections.length === 0)
}

// ───────────────────────────────────────────────────────────────────────────
// [G] 切换阶段同样只服务 tavern-play（不只是 agent/created 这一关）
// ───────────────────────────────────────────────────────────────────────────
{
  // tavern-play：允许切
  const { ctx, emit } = makeCtx({ presetValue: 'tavern-play' })
  apply(ctx, {})
  const { agent, state } = makeAgent('switch-play', { presetVia: 'composed' })
  await emit('agent/created', { agent, source: 'fresh' })
  state.selections.length = 0
  await emit('session/event', agent.session, { type: 'tool/result', data: {} })
  await new Promise((r) => setTimeout(r, 0))
  ok('[G] tavern-play 工具后切到 hy3', state.selections.length === 1 && state.selections[0].model === 'hy3', JSON.stringify(state.selections))
}
{
  // sprint：连状态都没有，工具结果来了也不该做任何事
  const { ctx, emit } = makeCtx({ presetValue: 'sprint' })
  apply(ctx, {})
  const { agent, state } = makeAgent('switch-sprint', { presetVia: 'composed' })
  await emit('agent/created', { agent, source: 'fresh' })
  await emit('session/event', agent.session, { type: 'tool/result', data: {} })
  await new Promise((r) => setTimeout(r, 0))
  ok('[G] sprint 工具后也不切', state.selections.length === 0, JSON.stringify(state.selections))
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  · ${item}`)
  process.exit(1)
}
