/**
 * dsh-memory-switch —— 记忆上下文注入的会话级开关（Host 半边）。
 *
 * ## 它解决什么
 *
 * @restregular/dsh-memory 的注入半边会在会话里**主动塞东西**：新会话第一步的摘要、
 * 每轮按问题召回、系统提示常驻的「记忆使用策略」/「硬性规则」/「流程索引」。
 * 这些都不问你愿不愿意 —— 面板里那几个开关是**全局**的，改一次所有会话一起变。
 *
 * 本插件补的正是缺的那一格：**每个会话自己决定**。
 *
 * 关掉只停「往上下文里注入」，不停记忆本身：
 *   - memory_save / search / get / list 照常可用，模型想知道什么可以自己查；
 *   - 记忆照旧落盘，别的会话、面板、以后的会话都不受影响。
 *
 * ## 已知代价（说清楚，别让人以为毫无痕迹）
 *
 * 本插件是**在注入发生之后把记忆摘掉**，不是让 dsh-memory 一开始就不注入。
 * 这是本方案最重要的短板，必须讲清楚：
 *
 *   - 每轮召回仍会在后台查一次（白花一点 CPU / 向量检索时间）；
 *   - **更严重：关着开关也会消耗上游的「已送达」状态。** 上游在生成时就写
 *     `markDigestDone()`（lib/inject/apply.js:1112）、`markContent` / `markHint`
 *     （1129-1131）、以及把规则正文当已进系统提示（1181-1184）。我用
 *     `await next()` 拿到结果时，这些副作用**已经发生了**，删消息撤不回来。
 *     后果：关着默认聊过几轮再打开，那条新会话一次性摘要和部分召回**不会补发**
 *     —— 上游以为送过了，按版本去重直接跳过（state.js:224-228）。
 *     重启也救不了：digestDone 是持久化的（apply.js:670）。
 *
 * 所以本插件的准确定位是**输出过滤器**，不是「让记忆完全不工作」。别再向用户
 * 承诺「打开就立刻有摘要和召回」。
 *
 * 要根治只有一条路：让 dsh-memory 在**生成前**查一次会话开关，关闭时既不生成、
 * 也不消费那些 done/去重状态（需要改上游代码）。
 *
 * 这个代价是刻意接受的：相比「动手改上游包、它一升级就失效」，
 * 「少一次摘要」的用户可见损失小得多，而且随时可拆。
 *
 * ## 为什么不能只改 dsh-memory 的配置
 *
 * 它的 settings.json 是进程级单例（`<storeDir>/settings.json`），没有会话维度。
 * 用它自己的 `inject.enabled` 等于「一刀切」，做不到「这个会话关、那个会话开」。
 *
 * ## 拦截点（两处，缺一不可）
 *
 * 1. `agent/pre-step` —— 摘要 / 每轮召回 / 自动召回 / 轮末提醒，都是往 decision.messages
 *    里追加一条 `source.kind === 'memory'` 的 user 消息。这里把这类消息剔掉即可。
 *
 * 2. `system-prompt/assemble` —— 「记忆使用策略」「硬性规则」「流程索引」三段不进
 *    messages，而是走 systemPrompt.section 注册成常驻段。这里按段名把它们从装配结果里
 *    摘掉。`assembleContextFor()` 会把 `agent` 放进 assemble context，所以能按会话判断。
 *
 * ### 顺序陷阱（踩过就懂）
 *
 * dsh-memory 用 `{ prepend: true }` 注册 pre-step —— 也就是**排在最外层**。
 * Cordis 的 waterfall 是「先注册的在外、由外到内」，prepend 会把后来者插到更外层。
 * 若我们在它之前的时刻注册，就会被它包在里面：它 await next() 拿到我们的结果后再追加，
 * 我们永远看不到它追加的那条消息。所以这里必须**后于它**注册，
 * 做法见 `installPreStepGuard()` 里的延迟注册。
 *
 * ## 状态
 *
 * 按会话存在 $DSH_HOME/dsh-memory-switch.json，Client 通过 /dsh-memory-switch-api 读写。
 * 用文件而不是 Session 事件：这是界面偏好而不是对话内容，且插件不能 append 新事件类型。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Loader entry id / 包名。Client bundle 的注册 id 必须与此一致。 */
export const name = 'dsh-memory-switch'

/** 依赖的宿主服务。webServer 缺了只是没有开关 UI，拦截照常工作。 */
export const inject = ['systemPrompt']

/** Client 读写开关的同源路由。 */
const ROUTE = '/dsh-memory-switch-api'

/** 记忆系统写进系统提示的三段名字（见 @restregular/dsh-memory lib/inject/apply.js）。 */
const MEMORY_SECTIONS = new Set(['memory:policy', 'memory:rules', 'memory:procedures'])

/** $DSH_HOME 解析：与 dsh-home-paths 同规则（配置 > 环境变量 > ~/.dsh）。 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'dsh-memory-switch.json')
}

/**
 * 新会话的默认值。
 *
 * 用户 2026-11-14 明确要求「新会话默认关」：注入太吵，想要时自己开。
 * 注意这只是**未显式设置过的会话**的默认，不覆盖任何会话自己的选择。
 * 想「把所有会话一起关掉」用 globalDisabled 总闸（见下）。
 */
const DEFAULT_ENABLED = false

/**
 * 读出的状态形状：
 *   sessions        —— 每个会话的显式选择（用户点过开关的那些）
 *   defaultEnabled  —— 没点过的会话用哪个值
 *   globalDisabled  —— 总闸：关掉时**所有**会话都不注入，但**不抹掉**各自的偏好
 *
 * 为什么总闸要独立于 defaultEnabled：两者语义不同。defaultEnabled 只影响
 * 「没表过态的会话」；如果拿它当总闸用，那些显式开过的会话不会跟着关，
 * 而且一旦想恢复又得逐条改回来。总闸是可逆的：关掉 → 全关；恢复 → 各自原样。
 */
function emptyState() {
  return { version: 1, sessions: {}, defaultEnabled: DEFAULT_ENABLED, globalDisabled: false }
}

/**
 * 读盘。任何异常都回落成空状态 —— 插件不能因为一个坏 JSON 起不来。
 *
 * `sessions` 必须原样带出来：早先 dsh-advisors 就栽在「只挑了一部分字段返回」，
 * 用户的选择在重启后被静默丢掉（见该插件 HANDOFF 第 0 节）。
 */
function loadState(logger) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState()
    const sessions = parsed.sessions !== null && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
      ? parsed.sessions
      : {}
    return {
      version: 1,
      sessions,
      defaultEnabled: typeof parsed.defaultEnabled === 'boolean' ? parsed.defaultEnabled : DEFAULT_ENABLED,
      globalDisabled: parsed.globalDisabled === true,
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger?.warn?.(`dsh-memory-switch: 状态文件不可读，按默认值处理：${error.message}`)
    }
    return emptyState()
  }
}

/**
 * 写盘：临时文件 + rename，避免半截 JSON。
 *
 * **失败必须抛出来。** 第一版这里吞掉了异常，HTTP 层照样回 `{ok:true}` —— 用户
 * 看到开关亮着、重启后却变回旧值，属于「谎报成功」。现在把错误抛给调用方，
 * 由它回 500，让 UI 能如实报错。
 */
function saveState(state) {
  const target = stateFile()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, target)
}

/** 只接受本机回环 Host（DNS rebinding 防线，和 dsh-meme / dsh-advisors 同口径）。 */
function hostIsLoopback(req) {
  const host = String(req.headers?.host ?? '')
  if (host === '') return true
  const value = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (value === 'localhost' || value === '::1' || value === '0.0.0.0') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * 一条消息是不是记忆系统注入的。
 *
 * **只认来源标记，绝不按文本猜。**
 *
 * 第一版还留了一条「段首出现【相关记忆】就算」的文本兜底，被审出来了：用户完全
 * 可能真的发一条以 `【相关记忆】` 开头的消息（贴一段让我解释、或把注入内容贴回来
 * 问这是什么），那条消息会被整条删掉 —— 用户会觉得「我没说话它就自己动了」。
 * 而删掉的又是**当前这一轮的用户输入**，比漏删危害大得多。
 *
 * 上游契约是确定的：dsh-memory 注入的每一条都走 createUserMessage，带
 * `source: { kind: 'memory', form: ... }`（lib/inject/apply.js:1371）。认这个就够。
 * 万一将来上游改成别的标记，结果是**漏删**（记忆照旧注入），而不是误删用户的话 ——
 * 这个失败方向是刻意选的。
 */
function isMemoryMessage(message) {
  const source = message?.source
  return source !== null && typeof source === 'object' && source.kind === 'memory'
}

/**
 * 从一段对话里剔掉记忆注入的消息。
 * @returns 剔掉了则返回新数组，没剔则返回原数组（调用方据此决定要不要换 decision）。
 */
function stripMemoryMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const kept = messages.filter((message) => !isMemoryMessage(message))
  return kept.length === messages.length ? messages : kept
}

/**
 * 判定「agent-loop 组装的原始请求」（与 dsh-inject 同口径，本机已核对宿主源码：
 * buildRequest 返回 `Object.freeze({...})`，带 sessionId 与 messages 数组）。
 *
 * 不能用 dsh-llm 的 `isAgentLoopRequest`：它查的是模块私有 WeakSet，
 * link 安装下插件与运行时可能不是同一个模块实例，检查会恒为 false。
 */
function isLoopRequest(options) {
  return Object.isFrozen(options)
    && typeof options?.sessionId === 'string'
    && Array.isArray(options.messages)
}

/** 从系统提示装配结果里剔掉记忆的三段。 */
function stripMemorySections(assembly) {
  if (assembly === null || typeof assembly !== 'object') return assembly
  const sections = assembly.sections
  if (!Array.isArray(sections) || sections.length === 0) return assembly
  const kept = sections.filter((section) => !MEMORY_SECTIONS.has(section?.name))
  if (kept.length === sections.length) return assembly
  return { ...assembly, sections: kept }
}

/**
 * 组装插件。
 * @param ctx - 宿主 Context。
 */
export function apply(ctx, config = {}) {
  const state = loadState(ctx.logger)

  /**
   * 各层拦截的真实状态。**分三件事记，别混成一个布尔。**
   *
   *   registered —— 监听真的注册上了（拿到 ctx.on 的 disposer 之后置位）
   *   observed   —— 这一层实际跑过（证明它确实在链路上）
   *   lastError  —— 这一层最近一次自己出错、被迫放行的原因
   *
   * 为什么必须分开：`try/catch` 放行只保证「不阻断对话」，**不保证「记忆已关闭」**。
   * 早先我只用一个布尔、且在监听体里才置位，导致两种误报：
   *   - 刚启动还没跑过 → 显示「未就绪」，其实已经挂好了（假警报）；
   *   - 装配层注册失败、但 pre-step 跑过 → 显示「就绪」，而系统提示里的记忆段
   *     其实还在注入（**真漏报**，这个更危险）。
   * 现在 UI 取 `preStep.registered && assembly.registered` 才算就绪；
   * observed 只用来表达「还没跑过验证」，不当失败处理。
   */
  const guards = {
    preStep: { registered: false, observed: false, lastError: null },
    assembly: { registered: false, observed: false, lastError: null },
    request: { registered: false, observed: false, lastError: null },
  }

  /** 某会话当前是否启用记忆注入。优先级：总闸 > 会话显式值 > 默认值。 */
  const enabledOf = (sessionId) => {
    // 总闸优先级最高，且**不改动**会话偏好本身，所以随时可逆。
    if (state.globalDisabled === true) return false
    const saved = sessionId === undefined || sessionId === null ? undefined : state.sessions[sessionId]?.enabled
    return typeof saved === 'boolean' ? saved : state.defaultEnabled === true
  }

  /** 总闸是不是关着（供自检与界面用）。 */
  const isGloballyDisabled = () => state.globalDisabled === true

  /**
   * 写一个补丁到状态里，**先落盘成功再更新内存**。
   *
   * 顺序不能反：先改内存再写盘，写盘失败时内存已经变了，界面显示的和磁盘上的
   * 就不是一回事（重启后又变回去）。这里构造下一版 → 写盘 → 成功后才替换引用，
   * 失败则原样抛出，内存状态一动不动。
   */
  const commit = (mutate) => {
    const next = {
      version: 1,
      sessions: { ...state.sessions },
      defaultEnabled: state.defaultEnabled === true,
      globalDisabled: state.globalDisabled === true,
    }
    mutate(next)
    saveState(next)
    state.sessions = next.sessions
    state.defaultEnabled = next.defaultEnabled
    state.globalDisabled = next.globalDisabled
  }

  const setEnabled = (sessionId, enabled) => {
    commit((next) => {
      next.sessions[sessionId] = { enabled, updatedAt: Date.now() }
    })
  }

  const setDefaultEnabled = (enabled) => {
    commit((next) => { next.defaultEnabled = enabled })
  }

  const setGlobalDisabled = (disabled) => {
    commit((next) => { next.globalDisabled = disabled })
  }

  /**
   * 会话 id 从 agent 上取。
   *
   * ## 子 Agent 的语义（刻意选择，写清楚免得误解）
   *
   * 子会话用自己的 session id 判断，因此**不继承**父会话的开关。而界面上
   * 子会话是不显示这个开关的（与相邻两个开关同一规则），这意味着子会话实际
   * 永远落在「默认值」上（当前 defaultEnabled=false → 一律不注入）。
   *
   * 这是有意的：子 Agent 的上下文越干净越好，记忆注入在子任务里价值低、噪音高。
   * 代价是「父会话开了、子会话不会跟着开」—— 不是 bug，是本插件的既定口径。
   * 想改的话把这里换成沿 parentSession 上溯即可，但同时要给它一个能改的入口。
   */
  const sessionIdOf = (agent) => {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * 该会话是否关闭了记忆注入。拿不到会话 id 时按「默认值」处理。
   *
   * 注意**不能直接读 state.defaultEnabled**：那样会绕过 globalDisabled 总闸。
   * 统一走 enabledOf(undefined) —— 它内部已经把「总闸 > 会话值 > 默认值」串好了，
   * 只有一处判断逻辑，不会出现「有这个分支忘了总闸」这种漏。
   */
  const injectionOffFor = (sessionId) => !enabledOf(sessionId)

  /** 该 agent 所在会话是否关闭了记忆注入。 */
  const injectionOff = (agent) => injectionOffFor(sessionIdOf(agent))

  // ---------------------------------------------------------------- 拦截 1：pre-step
  /**
   * 在 agent/pre-step 上把记忆追加的消息剔掉。
   *
   * **必须后于 dsh-memory 注册**：它用 prepend 注册，先注册的会被它包在内层，
   * 导致我们 await next() 之后它才追加，永远剔不到。这里用 setTimeout(0) 把注册
   * 推到当前这一批插件 apply 之后 —— 同一 tick 里所有插件的 apply 都是同步跑的，
   * 因此我们的注册一定在 dsh-memory 之后，prepend 也就一定在它更外层。
   */
  const installPreStepGuard = () => {
    const register = () => {
      try {
        ctx.on('agent/pre-step', async (input, next) => {
          guards.preStep.observed = true
          const decision = await next()
          // 拒绝 / 中止的步骤原样放行，绝不动它的结构。
          if (!decision || decision.kind === 'reject' || input?.signal?.aborted) return decision
          // 拦截器是增强，不是关卡：自己出任何问题都必须放行，绝不让本轮失败。
          try {
            if (!injectionOff(input?.agent)) return decision
            const stripped = stripMemoryMessages(decision.messages)
            return stripped === decision.messages ? decision : { ...decision, messages: stripped }
          } catch (error) {
            // 和另外两层一样记 lastError：这一层悄悄跳过时，界面才有据可查，
            // 而不是「开关显示关了、记忆其实还在」却查不到原因。
            guards.preStep.lastError = error && error.message ? error.message : String(error)
            ctx.logger?.warn?.(`dsh-memory-switch: pre-step 拦截跳过（不影响本轮）：${error && error.message}`)
            return decision
          }
        }, { prepend: true })
        // 注册成功就置位 —— 不能等到监听第一次执行。
        // 否则「刚启动、还没发过任何请求」会显示成「拦截器未就绪」，
        // 那是误报：不是没挂上，只是还没跑过。
        guards.preStep.registered = true
      } catch (error) {
        guards.preStep.lastError = error && error.message ? error.message : String(error)
        ctx.logger?.warn?.(`dsh-memory-switch: pre-step 拦截注册失败：${error && error.message}`)
      }
    }
    // 宿主可能还没到 ready；用 setImmediate 保证其它插件的 apply 已经跑完。
    if (typeof setImmediate === 'function') setImmediate(register)
    else setTimeout(register, 0)
  }

  // ---------------------------------------------------------------- 拦截 2：系统提示
  /**
   * 系统提示的三段走 assemble waterfall。`context.agent` 由 assembleContextFor 带进来，
   * 所以能按会话判断；不按会话（没有 agent）的装配只按全局默认处理。
   */
  const installAssemblyGuard = () => {
    try {
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        guards.assembly.observed = true
        const decision = await next()
        // 同 pre-step：自己出错就放行，绝不让装配失败。
        try {
          const agent = context?.agent
          // 拿不到 agent 时不猜：只按全局默认决定要不要剥。
          // 注意这里要用 effective 语义（总闸优先），不能直接读 defaultEnabled。
          const off = injectionOff(agent)
          if (!off) return decision
          return stripMemorySections(decision)
        } catch (error) {
          guards.assembly.lastError = error && error.message ? error.message : String(error)
          ctx.logger?.warn?.(`dsh-memory-switch: 系统提示拦截跳过：${error && error.message}`)
          return decision
        }
      })
      guards.assembly.registered = true
    } catch (error) {
      guards.assembly.lastError = error && error.message ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-memory-switch: 系统提示拦截注册失败：${error && error.message}`)
    }
  }

  // ---------------------------------------------------------------- 拦截 3：请求兜底
  /**
   * 最后一道：尽量在发给模型的请求副本上再剔一次。
   *
   * 为什么还要这一层 —— 前两层依赖「注册顺序」这个实现细节：dsh-memory 用
   * prepend 注册 pre-step，我们靠延后注册排在它更外层；万一宿主加载次序变了
   * （例如插件被切成两个 entry、或异步 apply），第 1 层会静默失效。
   *
   * ## 这一层**不能**承诺「顺序怎么变都能兜住」（上一版注释写错了，已改）
   *
   * 真实约束来自 dsh-inject（lib/index.js:374-390）：它同样在本事件里重派，而且
   * 它重派的是**未冻结**的副本。于是：
   *   - 我们先跑：我们产出的冻结副本它能认（isLoopRequest 为真），两边都生效；
   *   - **它先跑且真的改写了请求**：它重派未冻结副本 → 我们再进来时
   *     `isLoopRequest` 为 false → 我们直接放行，**记忆漏删**。
   *
   * 这是由「宿主没有统一的请求变换协议、每个插件各自重派」这个现状决定的，
   * 不是本插件能单方面解决的。我们能做的是把顺序尽量排对它（见 bundles 里排在
   * dsh-memory 之后），并在这里如实说明：**这一层是尽力而为的兜底，不是保证。**
   * 真正可靠的解法只有一条 —— 让 dsh-memory 在注入**前**就问一次开关（需改上游）。
   *
   * 另注：宿主把 loop 请求 deepFreeze 了，**不能改原对象**；我们派发的副本也保持
   * 冻结，因为 dsh-inject 用 `Object.isFrozen` 判定「是不是 loop 请求」，给它没冻结
   * 的副本会让它的破甲/注入预设静默失效。宿主自己的 forAdapter() 也是这个约定：
   * 原对象冻结 → 新副本继续 deepFreeze。
   *
   * ## 这一层曾经把整个对话搞挂（事故记录，别再犯）
   *
   * 1) 第一版在监听里直接写了 `ctx.llm.stream(...)`。Cordis 的规矩是：**没有通过
   *    `ctx.inject`/`inject` 声明过的服务，取它就是抛错**，报
   *    `cannot get property "llm" without inject`。那个异常发生在每一次「开关关着」
   *    的模型请求里，结果是连普通对话都跑不下去 —— 而不是「只是没拦截成功」。
   * 2) 第二版虽然有 try/catch，但把 `next()` 和 `scoped.llm.stream()` 都包在里面：
   *    下游一抛错就被当成「我过滤失败了」，catch 里又**调一次 next()**，于是请求
   *    可能被重复派发，或在真宿主里撞上 `next() called multiple times` 把这一轮崩掉。
   *
   * 三条铁律因此固定下来：
   *   1. 要用 `llm`，就写在 `ctx.inject(['llm'], …)` 里，用 scoped 上下文取；
   *   2. try 只包**纯计算**（读标记、查开关、算过滤），绝不包 `next()`/`stream()`；
   *   3. 决策定下来之后**只走一条路、只调一次** —— 拦截器是**增强**不是关卡。
   */
  const installRequestGuard = () => {
    try {
      ctx.inject(['llm'], (scoped) => {
        scoped.effect(() => scoped.on('llm/stream', (options, next) => {
          guards.request.observed = true
          /**
           * 只在这一步允许出错：读标记、查开关、算过滤。
           * 它必须是纯计算 —— 不派发、不调用 next()、不碰模型。
           *
           * 第一版把 `next()` 和 `scoped.llm.stream()` 都包在同一个 try 里，结果
           * 下游一抛错就被当成「我过滤失败了」，然后 catch 里**又调了一次 next()**：
           * 要么请求被重复派发（重复计费 / 重复输出），要么在真宿主里撞上
           * `next() called multiple times` 直接崩掉这一轮。这正是要避免的那类
           * 「插件自己的 bug 把对话搞挂」。
           */
          let replacement = null
          try {
            if (isLoopRequest(options) && injectionOffFor(options.sessionId)) {
              const stripped = stripMemoryMessages(options.messages)
              // messages 没变 → 没有记忆消息可剔，照常放行。
              // 这一条同时是**防重入闸门**：重派的副本仍带 sessionId，会再次进入
              // 本监听，但那时已经剔干净，于是直接走 next()，不会再派一次。
              if (stripped !== options.messages) {
                // 副本必须保持冻结：dsh-inject 用 Object.isFrozen 认「loop 原始
                // 请求」，给它没冻结的副本会让别的注入预设静默失效。
                replacement = Object.freeze({ ...options, messages: Object.freeze(stripped) })
              }
            }
          } catch (error) {
            guards.request.lastError = error && error.message ? error.message : String(error)
            scoped.logger?.warn?.(`dsh-memory-switch: 请求兜底跳过（不影响本轮）：${error && error.message}`)
            replacement = null
          }

          // 决策已定，下面**只走一条路、只调一次**。
          // 替换时的错误不再回退到 next()：请求已经可能发出去了，回退会重复请求。
          if (replacement === null) return next()
          return scoped.llm.stream(replacement)
        }), 'dsh-memory-switch: request guard')
        guards.request.registered = true
      })
    } catch (error) {
      guards.request.lastError = error && error.message ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-memory-switch: 请求兜底注册失败（前两层仍在）：${error && error.message}`)
    }
  }

  installPreStepGuard()
  installAssemblyGuard()
  installRequestGuard()

  // 会话归档 / 销毁时不需要清状态：开关是用户的选择，重开会话应当还在。

  // ---------------------------------------------------------------- HTTP 路由
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => scoped.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler(req, res) {
          const respond = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(value))
          }
          if (!hostIsLoopback(req)) {
            respond(403, { ok: false, error: '只接受本机请求' })
            return
          }
          const method = String(req.method ?? 'GET').toUpperCase()
          const url = new URL(String(req.url ?? ROUTE), 'http://127.0.0.1')

          /**
           * **GET 与 POST 必须返回同一份状态快照。**
           *
           * 第二版 POST 直接回显请求里的 `body.enabled`，于是总闸关着时点「开启」
           * 会得到 `enabled:true`，而实际 `enabledOf()` 仍是 false —— 界面显示已开、
           * 记忆其实没恢复注入（刷新一下又变回关）。这是反方向的谎报，和之前
           * 「保存失败仍回 ok」属于同一类错误。
           *
           * 现在统一走这一个函数：`enabled` 永远是**有效值**，`sessionOverride`
           * 才是「用户自己的偏好」。两者分开，界面才能说清「偏好已保存，但总闸
           * 关着，恢复后生效」。
           */
          const snapshotOf = (sessionId) => {
            const hasSession = sessionId !== '' && sessionId !== undefined
            const override = hasSession ? state.sessions[sessionId]?.enabled : undefined
            return {
              ok: true,
              sessionId,
              // 用户自己存的偏好（未表过态 = null），与总闸无关。
              sessionOverride: typeof override === 'boolean' ? override : null,
              // 真正生效的值：总闸 > 会话偏好 > 默认值。
              enabled: enabledOf(hasSession ? sessionId : undefined),
              defaultEnabled: state.defaultEnabled === true,
              globalDisabled: state.globalDisabled === true,
              guards: { ...guards },
              // 注意：这两个都是对象，`a && b` 会返回 b 本身而不是布尔值。
              // 第一次写就是这里漏了，运行中的接口真的返回了 `ready:{...}` ——
              // 客户端只做了 `!== false` 判断所以恰好没炸，但协议已经错了。
              // 必须显式取 `.registered` 再转布尔。
              ready: guards.preStep.registered === true && guards.assembly.registered === true,
            }
          }

          if (method === 'GET') {
            respond(200, snapshotOf(url.searchParams.get('sessionId') ?? ''))
            return
          }
          if (method === 'POST') {
            void (async () => {
              try {
                const body = await readJsonBody(req)
                if (typeof body.globalDisabled === 'boolean') {
                  setGlobalDisabled(body.globalDisabled)
                  respond(200, snapshotOf(typeof body.sessionId === 'string' ? body.sessionId.trim() : ''))
                  return
                }
                if (typeof body.defaultEnabled === 'boolean') {
                  setDefaultEnabled(body.defaultEnabled)
                  respond(200, snapshotOf(typeof body.sessionId === 'string' ? body.sessionId.trim() : ''))
                  return
                }
                const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
                if (sessionId === '' || typeof body.enabled !== 'boolean') {
                  respond(400, { ok: false, error: '需要 { sessionId, enabled }、{ defaultEnabled } 或 { globalDisabled }' })
                  return
                }
                setEnabled(sessionId, body.enabled)
                // 回真实快照，不回显请求：总闸关着时要让界面看出「存了但没生效」。
                respond(200, snapshotOf(sessionId))
              } catch (error) {
                // 写盘失败必须如实报出来：界面会回滚开关并显示原因，
                // 而不是「看起来保存成功、重启后却变回去」。
                respond(500, { ok: false, error: error && error.message ? error.message : String(error) })
              }
            })()
            return
          }
          respond(405, { ok: false, error: 'method not allowed' })
        },
      }), 'dsh-memory-switch: toggle route')
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-memory-switch: HTTP 路由注册失败（开关 UI 不可用，拦截照常）：${error && error.message}`)
  }

  // 给自检用：把内部判定函数挂出去，测试脚本可以断言而不必猜。
  try {
    ctx.provide('memorySwitch', {
      enabledOf,
      isGloballyDisabled,
      isMemoryMessage,
      stripMemoryMessages,
      stripMemorySections,
      sessionIdOf,
      // 仅供自检：验证「写盘失败时状态不漂移」需要能直接触发一次写入。
      _setEnabledForTest: setEnabled,
    })
  } catch { /* 老宿主不支持 provide 时忽略 */ }
}
