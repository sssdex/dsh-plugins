/**
 * dsh-tavern-model-handoff 自测。零依赖，`node test/selftest.mjs`。
 *
 * 覆盖两层：
 *   [1] 纯逻辑（pickEffort / isBlankSession / presetMatches / sameRoute / toSelection）
 *   [2] 用假 ctx 跑完整 apply()，复现真实崩溃点：
 *       session/event 期间 session 处于 appending=true，此时 select() 必须抛
 *       reentry 错误 —— 验证插件确实是「推迟到提交之外」才切的。
 *       真实报错原文：session append cannot reenter while another append is being published
 */

let pass = 0
let fail = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    pass++
  } else {
    fail++
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(name, a === b, `期望 ${b}，实际 ${a}`)
}

// ───────────────────────────────────────────────────────────────────────────
// 假宿主
// ───────────────────────────────────────────────────────────────────────────

/**
 * 建一个假 cordis 上下文。
 * @param {{ efforts?: any, resolveDelayMs?: number, throwOnResolve?: boolean }} options
 */
function makeCtx(options = {}) {
  const hooks = new Map()
  const logs = []
  const ctx = {
    logger: (scope) => ({
      info: (message) => logs.push(['info', scope, message]),
      warn: (message) => logs.push(['warn', scope, message]),
      error: (message) => logs.push(['error', scope, message]),
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
        const current = hooks.get(name) ?? []
        const index = current.indexOf(hook)
        if (index >= 0) current.splice(index, 1)
        return true
      }
    },
    get: () => undefined,
    llm: {
      async resolveModelInfo() {
        if (options.throwOnResolve === true) throw new Error('adapter down')
        if (options.resolveDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.resolveDelayMs))
        }
        if (options.efforts === undefined) return { reasoning: undefined }
        return { reasoning: { efforts: options.efforts } }
      },
    },
  }

  /** 触发一个事件（emit 语义，全部监听器都跑）。支持多参数，和真实派发一致。 */
  const emit = async (name, ...payload) => {
    for (const hook of [...(hooks.get(name) ?? [])]) await hook.listener(...payload)
  }

  /** 触发 waterfall 语义（next 串行）。 */
  const waterfall = async (name, payload, inner) => {
    const list = [...(hooks.get(name) ?? [])]
    const run = (index) => {
      const hook = list[index]
      if (hook === undefined) return inner()
      const next = () => run(index + 1)
      return hook.listener(payload, next)
    }
    return run(0)
  }

  return { ctx, hooks, logs, emit, waterfall }
}

/**
 * 假 session + agent。`appending` 模拟 commit 期内部状态。
 */
function makeSession(id, events = []) {
  const state = {
    id,
    header: { agentPreset: 'tavern-play' },
    appending: false,
    eventLog: [...events],
    selections: [],
  }
  const session = {
    id,
    header: { agentPreset: 'tavern-play' },
    snapshotEvents: (from = 0) => state.eventLog.slice(from),
    get appendingNow() {
      return state.appending
    },
    append(type, data) {
      // 关键：复现真实宿主在 commit 期间禁止再 append 的行为。
      if (state.appending) {
        throw new Error('session append cannot reenter while another append is being published')
      }
      state.eventLog.push({ type, data })
    },
    _state: state,
  }
  const model = {
    _current: { provider: 'workbuddy-global', model: 'hy3', reasoningEffort: 'high' },
    current() {
      return { ...model._current }
    },
    select(selection) {
      session.append('model/selection', selection)
      model._current = { ...selection }
      state.selections.push({ ...selection })
    },
  }
  const agent = {
    id,
    session,
    ctx: {},
    model,
  }
  return { agent, session, state }
}

// ───────────────────────────────────────────────────────────────────────────
// [1] 纯逻辑
// ───────────────────────────────────────────────────────────────────────────
{
  const { pickEffort, isBlankSession, presetMatches, sameRoute, toSelection } = await import('../index.js')

  // off 可用 → 用 off，不算降级
  eq('[1] off 可用', pickEffort([{ id: 'off' }, { id: 'low' }, { id: 'high' }]), {
    effort: 'off',
    degraded: false,
    unknown: false,
  })

  // 只有 low/high（正是 hy3 上游声明的形态）→ 退到 low 并标降级
  eq('[1] 只有 low/high → 退 low', pickEffort([{ id: 'low' }, { id: 'high' }]), {
    effort: 'low',
    degraded: true,
    unknown: false,
  })

  // 空 / 缺失 → 不加档位
  eq('[1] 空数组', pickEffort([]), { effort: undefined, degraded: true, unknown: true })
  eq('[1] undefined', pickEffort(undefined), { effort: undefined, degraded: true, unknown: true })

  // 字符串数组也要认
  eq('[1] 字符串数组含 off', pickEffort(['off', 'minimal']), {
    effort: 'off',
    degraded: false,
    unknown: false,
  })

  // 自定义首选
  eq('[1] 首选 high', pickEffort([{ id: 'low' }, { id: 'high' }], 'high'), {
    effort: 'high',
    degraded: false,
    unknown: false,
  })

  // 有档位但都不在词表里 → 退到声明第一项，不猜不炸
  eq('[1] 未知档位词表', pickEffort([{ id: 'turbo' }, { id: 'eco' }]), {
    effort: 'turbo',
    degraded: true,
    unknown: false,
  })

  // 空白会话判定
  ok('[1] 空日志 = 空白会话', isBlankSession([]) === true)
  ok('[1] 有 turn/start 不算空白', isBlankSession([{ type: 'turn/start' }]) === false)
  ok('[1] 有 step/start 不算空白', isBlankSession([{ type: 'session/title' }, { type: 'step/start' }]) === false)
  ok('[1] 只有 seed 事件仍算空白', isBlankSession([{ type: 'session/end-seed' }]) === true)
  ok('[1] undefined 不算空白（保守）', isBlankSession(undefined) === false)

  // 预设匹配：只认名单里的
  ok('[1] 命中 tavern-play', presetMatches('tavern-play', ['tavern-play']) === true)
  ok('[1] 不命中 spring', presetMatches('spring', ['tavern-play']) === false)
  ok('[1] 空身份不命中', presetMatches('', ['tavern-play']) === false)
  ok('[1] 不命中官方 tavern', presetMatches('tavern', ['tavern-play']) === false)

  // 路由比较只看 provider+model
  ok('[1] 同路由不同档位', sameRoute({ provider: 'a', model: 'b', reasoningEffort: 'off' }, { provider: 'a', model: 'b' }) === true)
  ok('[1] 不同模型', sameRoute({ provider: 'a', model: 'b' }, { provider: 'a', model: 'c' }) === false)
  ok('[1] undefined 不相等', sameRoute(undefined, { provider: 'a', model: 'b' }) === false)

  // toSelection 不写 undefined
  eq('[1] toSelection 有档位', toSelection({ provider: 'p', model: 'm' }, 'off'), {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'off',
  })
  eq('[1] toSelection 无档位', toSelection({ provider: 'p', model: 'm' }, undefined), { provider: 'p', model: 'm' })
  ok(
    '[1] toSelection 不含 reasoningEffort 键',
    Object.prototype.hasOwnProperty.call(toSelection({ provider: 'p', model: 'm' }, undefined), 'reasoningEffort') === false,
  )
}

// ───────────────────────────────────────────────────────────────────────────
// [2] 集成：真实时序
// ───────────────────────────────────────────────────────────────────────────
{
  const { apply } = await import('../index.js')
  const { ctx, logs, emit, waterfall } = makeCtx({
    // hy3 上游典型声明：只有 low/high，没有 off
    efforts: [{ id: 'low' }, { id: 'high' }],
  })
  apply(ctx, {})

  const { agent, session, state } = makeSession('sess-a', [])
  await emit('agent/created', { agent, source: 'fresh' })

  // 1. 开局必须锁到中转站 flash
  eq('[2] 开局模型 = zzz1/deepseek-flash', { provider: state.selections.at(-1)?.provider, model: state.selections.at(-1)?.model }, {
    provider: 'zzz1',
    model: 'deepseek-flash',
  })

  // 2. 工具结果落定 → 触发切换。这里让 session 处于「提交期」，
  //    如果插件在监听器里直接 select，就会撞 reentry 抛错。
  state.selections.length = 0
  state.appending = true
  let reentryThrown = false
  try {
    await emit('session/event', session, { type: 'tool/result', data: {} })
  } catch (error) {
    reentryThrown = true
  }
  state.appending = false
  ok('[2] 提交期派发本身不抛（插件没在监听器里写）', reentryThrown === false)

  // eslint-disable-next-line no-undef
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq('[2] 工具结果后切到 workbuddy-global/hy3 + low（降级）', state.selections.at(-1), {
    provider: 'workbuddy-global',
    model: 'hy3',
    reasoningEffort: 'low',
  })

  // 3. 必须有一条明确说明「不是真无思考」的告警
  ok(
    '[2] 降级时有明确告警',
    logs.some(
      (entry) => entry[0] === 'warn' && String(entry[2]).includes('这不是真无思考'),
    ),
    JSON.stringify(logs.filter((e) => e[0] === 'warn').map((e) => e[2])),
  )

  // 4. 只切一次：再来一个 tool/result 不应该再 select
  const countBefore = state.selections.length
  await emit('session/event', session, { type: 'tool/result', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq('[2] 只切一次，不来回切', state.selections.length, countBefore)
}

// ───────────────────────────────────────────────────────────────────────────
// [3] off 可用时用 off，且不降级
// ───────────────────────────────────────────────────────────────────────────
{
  const { apply } = await import('../index.js')
  const { ctx, logs, emit } = makeCtx({ efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] })
  apply(ctx, {})
  const { agent, session, state } = makeSession('sess-b', [])
  await emit('agent/created', { agent, source: 'fresh' })
  state.selections.length = 0
  await emit('session/event', session, { type: 'turn/end', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq('[3] off 可用 → 直接 off', state.selections.at(-1), {
    provider: 'workbuddy-global',
    model: 'hy3',
    reasoningEffort: 'off',
  })
  ok(
    '[3] 没有降级告警',
    logs.every((entry) => !(entry[0] === 'warn' && String(entry[2]).includes('退到最低可用档'))),
  )
}

// ───────────────────────────────────────────────────────────────────────────
// [4] 安全边界：非 tavern-play 完全不碰
// ───────────────────────────────────────────────────────────────────────────
{
  const { apply } = await import('../index.js')
  const { ctx, emit } = makeCtx({ efforts: [{ id: 'off' }] })
  apply(ctx, {})
  const { agent, state } = makeSession('sess-c', [])
  agent.session.header = { agentPreset: 'spring' }
  await emit('agent/created', { agent, source: 'fresh' })
  eq('[4] 非 tavern-play 一次都不 select', state.selections.length, 0)
}
{
  // 有历史的 tavern-play 会话也不动（恢复会话不该被改模型）
  const { apply } = await import('../index.js')
  const { ctx, emit } = makeCtx({ efforts: [{ id: 'off' }] })
  apply(ctx, {})
  const { agent, state } = makeSession('sess-d', [{ type: 'turn/start', data: {} }])
  await emit('agent/created', { agent, source: 'resume' })
  eq('[4] 已有历史的会话不动模型', state.selections.length, 0)
}

// ───────────────────────────────────────────────────────────────────────────
// [5] 能力查询失败：仍能切过去，但要明确告警
// ───────────────────────────────────────────────────────────────────────────
{
  const { apply } = await import('../index.js')
  const { ctx, emit, logs } = makeCtx({ throwOnResolve: true })
  apply(ctx, {})
  const { agent, session, state } = makeSession('sess-e', [])
  await emit('agent/created', { agent, source: 'fresh' })
  state.selections.length = 0
  await emit('session/event', session, { type: 'tool/result', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq('[5] 查不到能力仍切过去（不加档位）', state.selections.at(-1), {
    provider: 'workbuddy-global',
    model: 'hy3',
  })
  ok(
    '[5] 查不到能力有告警',
    logs.some((entry) => entry[0] === 'warn' && String(entry[2]).includes('无法解析')),
  )
}

// ───────────────────────────────────────────────────────────────────────────
// [6] 抹除「模型已变更」提示
// ───────────────────────────────────────────────────────────────────────────
{
  const { apply } = await import('../index.js')
  const { ctx, emit, waterfall } = makeCtx({ efforts: [{ id: 'off' }] })
  apply(ctx, {})
  const { agent, session } = makeSession('sess-f', [])
  await emit('agent/created', { agent, source: 'fresh' })
  await emit('session/event', session, { type: 'tool/result', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const notice = {
    source: { kind: 'model-selection', form: 'notice' },
    content: [{ type: 'text', text: '[model changed: …]' }],
  }
  const real = { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }

  // 模拟 installModelSelection 的行为：在 next() 之后把 notice 拼到末尾。
  const decision = await waterfall(
    'agent/pre-step',
    { agent, step: 2, messages: [real] },
    () => Promise.resolve({ kind: 'enter', messages: [real, notice] }),
  )
  eq('[6] notice 被抹掉，正文留下', decision.messages.length, 1)
  ok('[6] 留下的是正文', decision.messages[0] === real)

  // 只抹一次：第二次不再动
  const second = await waterfall(
    'agent/pre-step',
    { agent, step: 3, messages: [real] },
    () => Promise.resolve({ kind: 'enter', messages: [real, notice] }),
  )
  eq('[6] 只抹一次', second.messages.length, 2)
}

// ───────────────────────────────────────────────────────────────────────────
// [7] 竞态：能力解析慢于工具结果 —— 仍然要补切，不能整局卡在 flash
// ───────────────────────────────────────────────────────────────────────────
{
  const { apply } = await import('../index.js')
  const { ctx, emit } = makeCtx({
    efforts: [{ id: 'low' }, { id: 'high' }],
    resolveDelayMs: 60,
  })
  apply(ctx, {})
  const { agent, session, state } = makeSession('sess-g', [])

  // agent/created 立刻返回（不 await 能力解析）
  await emit('agent/created', { agent, source: 'fresh' })
  eq('[7] 开局仍是 flash（不等能力）', state.selections.at(-1), {
    provider: 'zzz1',
    model: 'deepseek-flash',
  })

  // 能力还没解析完，工具结果就先到了 → 这一刻切不了
  state.selections.length = 0
  await emit('session/event', session, { type: 'tool/result', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq('[7] 能力未就绪时先不切', state.selections.length, 0)

  // 等能力解析回调 → 必须补切
  await new Promise((resolve) => setTimeout(resolve, 140))
  eq('[7] 能力就绪后补切到 hy3+low', state.selections.at(-1), {
    provider: 'workbuddy-global',
    model: 'hy3',
    reasoningEffort: 'low',
  })
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  · ${item}`)
  process.exit(1)
}
