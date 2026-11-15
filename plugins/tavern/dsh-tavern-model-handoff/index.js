/**
 * dsh-tavern-model-handoff —— 酒馆扮演的「开局读卡 → 换人出正文」模型接力。
 *
 * 症状：酒馆·扮演开局要先 read 卡、grep 目录、跑命令。这些工具步骤用
 * workbuddy-global/hy3 出正文很浪费：hy3 是 only-reasoning 模型，读卡这种
 * 确定性任务它也会先推演一遍；而真正需要「感情表达」的是读完卡之后的正文。
 *
 * 做法（用户在 2026-11-12 明确选定的语义）：
 *   1. 新开的 tavern-play 会话，第一步强制走中转站 flash（zzz1/deepseek-flash）；
 *   2. 第一个工具结果落定（或第一回合结束，兜底没调工具的情况）之后，
 *      一次性切到 workbuddy-global/hy3 + 无思考（reasoningEffort = off）；
 *   3. 之后整局锁定，不再来回切。
 *
 * 三条安全边界：
 *   · 只认 preset ∈ presets（默认只有 tavern-play）。编程会话、备卡、官方酒馆模式一概不碰。
 *   · 只在「会话还没有任何一步」的空白会话上强塞 flash。恢复/有历史的会话不动。
 *   · 切不过去就退到底档并明确告警，绝不让整轮请求报错中断。
 *
 * ── 时序（改动前务必读完，这里每条都是踩过的坑）──────────────────────────
 *
 * 1. 为什么「切换」必须在工具结果之后、下一步之前完成：
 *    agent-loop 的 preStep() 每一步都重新读 agent.model.current()。
 *    `select()` 只写一条 model/selection 事件，不打断进行中的请求，
 *    所以下一步自然用新模型 —— 正是要的效果。
 *
 * 2. 为什么监听器里不能直接 select()：
 *    session/event 是在 session.commit() 内部同步调用的，此时
 *    entry.appending === true。select() 要 append，会抛
 *    「session append cannot reenter while another append is being published」。
 *    所以先 queueMicrotask（commit 的 finally 已把 appending 置回 false），
 *    在微任务里再同步 select()。
 *
 * 3. 为什么档位能力必须提前查好：
 *    resolveModelInfo() 是 async。若在切换那一刻才 await，续体会排在
 *    agent-loop 的续体之后 —— 赶不上下一步，等于白切。
 *    因此能力在 agent/created 阶段（串行事件，允许 await）就查好并缓存，
 *    切换时纯同步取用。
 *
 * 4. 为什么「抹掉模型变更提示」要重新注册监听器：
 *    @deepseek-ai/dsh-agent 的 installModelSelection() 在每个 agent 的 setup
 *    阶段往 agent/pre-step 的队首（prepend）塞监听器，它在 next() 返回之后
 *    才把「[model changed: …]」这条 notice 拼到 messages 末尾。
 *    waterfall 的队首 = 最外层 = 最先执行。本插件在 profile 启动时就注册了，
 *    会排在队首；而每个新 agent 的 installModelSelection 又插到更前，
 *    把本插件挤到内层 —— 内层拿到的 decision 里还没有 notice，抹不掉。
 *    解法：每次 agent/created 时「先 dispose 再 prepend 重注册」，
 *    保证本插件始终在最外层，于是 next() 回来时 notice 已在手上。
 *    失败也只是没抹掉（多一行提示），绝不影响主流程。
 */

export const name = 'dsh-tavern-model-handoff'

/**
 * 只要 llm（查能力）。agentPresets 用 ctx.get() 可选取得：
 * 拿不到就不接管，宁可失效也不误伤。
 */
export const inject = ['llm']

/** 默认：开局读卡用中转站 flash。 */
const DEFAULT_FLASH = { provider: 'zzz1', model: 'deepseek-flash' }

/** 默认：正文交给 workbuddy 的 global hy3。 */
const DEFAULT_TARGET = { provider: 'workbuddy-global', model: 'hy3' }

/** 默认只服务这一个预设。 */
const DEFAULT_PRESETS = ['tavern-play']

/** 档位由低到高。`off` 是最低（等于不发思考）。 */
const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 查能力的超时；超时就按「查不到」处理，不拖住 agent 创建。 */
const RESOLVE_TIMEOUT_MS = 3000

/** 切换失败后的重试上限（撞 reentry 只是这一瞬不行，不是永远不行）。 */
const MAX_SWITCH_RETRIES = 5

/**
 * 从模型声明的档位里挑一个。
 *
 * @param effortIds 适配器报告的 effort 列表（元素可以是字符串或 `{id}`）。
 * @param preferred 首选档位，默认 off（无思考）。
 * @returns `{ effort, degraded, unknown }`
 *   - effort 为 undefined 表示「不加档位，走适配器默认」；
 *   - degraded 表示没拿到首选，已退档；
 *   - unknown 表示列表不可用（查不到能力）。
 */
export function pickEffort(effortIds, preferred = 'off') {
  const ids = Array.isArray(effortIds)
    ? effortIds.map((item) => (typeof item === 'string' ? item : item?.id)).filter((id) => typeof id === 'string' && id !== '')
    : []
  if (ids.length === 0) return { effort: undefined, degraded: true, unknown: true }
  if (ids.includes(preferred)) return { effort: preferred, degraded: false, unknown: false }
  const ranked = EFFORT_ORDER.filter((level) => ids.includes(level))
  if (ranked.length > 0) return { effort: ranked[0], degraded: true, unknown: false }
  // 声明里有档位但都不在我们的词表里：退到它声明的第一项，不猜。
  return { effort: ids[0], degraded: true, unknown: false }
}

/**
 * 会话是否「还一步都没走过」——只有这种会话才允许强塞开局模型。
 * @param events 会话日志（任意可遍历的 `{type}`）。
 */
export function isBlankSession(events) {
  if (events === undefined || events === null) return false
  for (const event of events) {
    if (event?.type === 'turn/start' || event?.type === 'step/start') return false
  }
  return true
}

/** 预设身份是否命中名单。 */
export function presetMatches(candidate, allowed) {
  if (typeof candidate !== 'string' || candidate === '') return false
  const list = Array.isArray(allowed) ? allowed : []
  return list.includes(candidate)
}

/** 路由是否一致（比较 provider + model，不比档位）。 */
export function sameRoute(left, right) {
  return left !== undefined && left !== null && right !== undefined && left.provider === right.provider && left.model === right.model
}

/** 组装 selection，缺省的键不写（写 undefined 会被 schema 拒）。 */
export function toSelection(route, effort) {
  return {
    provider: route.provider,
    model: route.model,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }
}

/** 切换时机：工具结果落定，或第一回合自然结束（兜底「没调工具」的情况）。 */
function isSwitchTrigger(eventType) {
  return eventType === 'tool/result' || eventType === 'turn/end'
}

/** 判断一条 message 是否是 DSH 自己插入的「模型已变更」提示。 */
function isModelSwitchNotice(message) {
  const source = message?.source
  return source?.kind === 'model-selection' && source?.form === 'notice'
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  if (process.env.DSH_TAVERN_MODEL_HANDOFF === '0') return

  const flash = {
    provider: config.flash?.provider ?? DEFAULT_FLASH.provider,
    model: config.flash?.model ?? DEFAULT_FLASH.model,
  }
  const target = {
    provider: config.target?.provider ?? DEFAULT_TARGET.provider,
    model: config.target?.model ?? DEFAULT_TARGET.model,
  }
  const preferredEffort =
    typeof config.target?.reasoningEffort === 'string' && config.target.reasoningEffort !== ''
      ? config.target.reasoningEffort
      : 'off'
  const presets = Array.isArray(config.presets) && config.presets.length > 0 ? config.presets : DEFAULT_PRESETS
  const stripSwitchNotice = config.stripSwitchNotice !== false

  const log = (level, message) => {
    try {
      ctx.logger('dsh-tavern-model-handoff')[level](message)
    } catch {
      // logger 不可用就算了，绝不影响主流程。
    }
  }
  const warn = (message) => log('warn', message)
  const info = (message) => log('info', message)

  /** 每个 agent 的接力状态。phase: armed → switching → switched / failed */
  const states = new Map()

  /** 预设身份：composedPreset → 投影 → header → 日志，四路兜底。 */
  const presetOf = (agent) => {
    const session = agent?.session
    try {
      const registry = ctx.get('agentPresets')
      const composed = registry?.composedPreset?.(agent.ctx)
      if (typeof composed === 'string' && composed !== '') return composed
      const recorded = registry?.presetForSession?.(session)
      if (typeof recorded === 'string' && recorded !== '') return recorded
    } catch {
      // 注册表不可用，继续往下兜底。
    }
    try {
      const headerPreset = session?.header?.agentPreset
      if (typeof headerPreset === 'string' && headerPreset !== '') return headerPreset
    } catch {}
    try {
      const events = session?.snapshotEvents?.()
      if (events !== undefined) {
        let latest
        for (const event of events) {
          if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
            latest = event.data.agentPreset
          }
        }
        if (latest !== undefined) return latest
      }
    } catch {
      // 会话日志读不到就算了。
    }
    return undefined
  }

  /** 目标路由的档位决策，按 `provider/model` 缓存（存 Promise，避免并发重复解析）。 */
  const effortCache = new Map()

  const resolveTargetEffort = () => {
    const key = `${target.provider}/${target.model}`
    const cached = effortCache.get(key)
    if (cached !== undefined) return cached

    const pending = (async () => {
      try {
        const resolved = await Promise.race([
          ctx.llm.resolveModelInfo(target.provider, target.model),
          new Promise((resolve) => setTimeout(() => resolve(undefined), RESOLVE_TIMEOUT_MS)),
        ])
        const decision = pickEffort(resolved?.reasoning?.efforts, preferredEffort)
        if (decision.unknown) {
          warn(`解析 ${key} 的推理档位为空（超时或适配器未报能力），切换时不加档位，实际档位由适配器默认决定。`)
        }
        return decision
      } catch (error) {
        warn(
          `无法解析 ${key} 的推理档位（${error?.message ?? error}），切换时不加档位，` +
            `实际档位由适配器默认决定 —— 可能不是无思考。`,
        )
        return { effort: undefined, degraded: true, unknown: true }
      }
    })()

    effortCache.set(key, pending)
    return pending
  }

  /** 真正执行切换。必须同步完成（见文件头时序 2、3）。 */
  const switchNow = (sessionId, reason) => {
    const state = states.get(sessionId)
    if (state === undefined || state.phase !== 'armed') return
    const decision = state.effort
    if (decision === undefined) {
      // 能力还没解析好：记下「已经该切了」。等解析回调用 trigger 补切，
      // 否则这一次 tool/result 就成了唯一的窗口，错过就整局卡在 flash。
      state.triggered = reason
      return
    }

    state.phase = 'switching'
    try {
      const selection = toSelection(target, decision.effort)
      const current = state.agent.model.current?.()
      if (sameRoute(current, target) && (current?.reasoningEffort ?? undefined) === decision.effort) {
        state.phase = 'switched'
        return
      }
      state.agent.model.select(selection)
      state.phase = 'switched'
      state.noticePending = stripSwitchNotice

      const route = `${target.provider}/${target.model}`
      if (decision.unknown) {
        warn(`已在 ${reason} 后切到 ${route}，但未能确认无思考能力，实际档位由适配器默认决定。`)
      } else if (decision.degraded) {
        warn(
          `已在 ${reason} 后切到 ${route}，但该模型不支持 "${preferredEffort}"，` +
            `已退到最低可用档 "${decision.effort}"（这不是真无思考）。`,
        )
      } else {
        info(`已在 ${reason} 后切到 ${route}（reasoningEffort=${decision.effort}）。`)
      }
    } catch (error) {
      // 切换失败也要自救：撞上 reentry 只是「这一瞬不行」，不是「永远不行」。
      // 退回 armed 并排一次有界重试，避免整局卡在 flash 上没人再触发。
      state.phase = 'armed'
      state.retries = (state.retries ?? 0) + 1
      if (state.retries <= MAX_SWITCH_RETRIES) {
        setTimeout(() => switchNow(sessionId, `${reason}(retry ${state.retries})`), 0)
      } else {
        state.phase = 'failed'
        warn(
          `切换到 ${target.provider}/${target.model} 连续 ${MAX_SWITCH_RETRIES} 次失败，已放弃：` +
            `${error?.message ?? error}。本局继续留在 ${flash.provider}/${flash.model}。`,
        )
      }
    }
  }

  /** 推迟到 session 提交之外再同步切换（时序 2）。 */
  const scheduleSwitch = (sessionId, reason) => {
    queueMicrotask(() => {
      // 失败自救由 switchNow 自己排（有界重试），这里只管「别在提交期写」。
      switchNow(sessionId, reason)
    })
  }

  // ── 抹除「模型已变更」提示 ─────────────────────────────────────────────
  // 单独抽成函数，靠「每次 agent/created 重注册」保证自己一直在队首（时序 4）。
  let noticeStripper
  const installNoticeStripper = () => {
    const listener = async (payload, next) => {
      const decision = await next()
      try {
        const state = states.get(payload?.agent?.id)
        if (state?.noticePending !== true) return decision
        if (decision?.kind === 'reject') return decision
        const messages = Array.isArray(decision?.messages) ? decision.messages : undefined
        if (messages === undefined) return decision
        const kept = messages.filter((message) => !isModelSwitchNotice(message))
        if (kept.length === messages.length) {
          // 这一轮没有 notice（首次请求不插），保持待命。
          return decision
        }
        state.noticePending = false
        return { ...decision, messages: kept }
      } catch (error) {
        warn(`抹除模型变更提示失败（已忽略，多一行提示而已）：${error?.message ?? error}`)
        return decision
      }
    }
    if (noticeStripper !== undefined) {
      try {
        noticeStripper()
      } catch {}
      noticeStripper = undefined
    }
    try {
      noticeStripper = ctx.on('agent/pre-step', listener, { prepend: true })
    } catch (error) {
      warn(`注册模型变更提示抹除器失败（不抹了，多一行提示而已）：${error?.message ?? error}`)
    }
  }

  // ── 1. 新会话：强塞开局 flash ──────────────────────────────────────────
  ctx.on('agent/created', async ({ agent }) => {
    try {
      const sessionId = agent?.id
      const session = agent?.session
      if (typeof sessionId !== 'string' || session === undefined) return

      const preset = presetOf(agent)
      if (!presetMatches(preset, presets)) return

      const events = session.snapshotEvents?.()
      if (!isBlankSession(events)) {
        info(`会话 ${sessionId} 已有历史，不接管模型（只对全新会话生效）。`)
        return
      }

      // 不 await：会话创建是热路径，等最多 3 秒会把开局拖慢。
      // 先同步锁 flash，能力后台解析；解析回来时若已经该切了，立刻补切。
      void resolveTargetEffort().then((resolved) => {
        const pending = states.get(sessionId)
        if (pending === undefined) return
        pending.effort = resolved
        if (pending.triggered !== undefined && pending.phase === 'armed') {
          scheduleSwitch(sessionId, pending.triggered)
        }
      })

      const current = agent.model.current?.()
      if (!sameRoute(current, flash)) {
        agent.model.select(toSelection(flash))
      }
      info(
        `新会话（${preset}）开局锁 ${flash.provider}/${flash.model}；` +
          `首个工具结果后切 ${target.provider}/${target.model}(${preferredEffort})。`,
      )

      states.set(sessionId, { agent, phase: 'armed', effort: undefined, triggered: undefined, noticePending: false })
      installNoticeStripper()
    } catch (error) {
      warn(`agent/created 处理失败（不接管）：${error?.message ?? error}`)
    }
  })

  // ── 2. 工具结果落定 / 回合结束 → 一次性切换 ─────────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return
      if (!isSwitchTrigger(event?.type)) return
      const state = states.get(sessionId)
      if (state === undefined || state.phase !== 'armed') return
      scheduleSwitch(sessionId, event.type)
    } catch (error) {
      warn(`session/event 处理失败（已忽略）：${error?.message ?? error}`)
    }
  })

  // ── 3. 回收 ────────────────────────────────────────────────────────────
  ctx.on('agent/disposed', ({ agent }) => {
    try {
      if (typeof agent?.id === 'string') states.delete(agent.id)
    } catch {}
  })

  info(
    `active：${presets.join(',')} → 开局 ${flash.provider}/${flash.model}，` +
      `工具后 ${target.provider}/${target.model}(${preferredEffort})` +
      `${stripSwitchNotice ? '' : '，保留模型变更提示'}`,
  )
}
