/**
 * dsh-advisors —— 只读顾问子智能体（统一走 GPT-6 Astra）。
 *
 * 目的：主智能体在遇到「前端 / 视觉审美 / 建模 / 后端」这类需要另一种模型的
 * 判断力的问题时，可以开一个**真实子智能体**去问方法与建议，而不是自己硬猜。
 * 四个领域一律使用 GPT-6 Astra（2026-11-13 主人决定不再用 Claude Opus 5.5）。
 *
 * 三重边界，保证顾问「只动嘴不动手」：
 *   1. 预设边界 —— 子智能体跑在 `advisor` 预设上，该预设只挂把 `read`/`read_image`
 *      （只读）和 `glob`/`grep`，没有 write / edit / apply_patch / bash / pwsh。
 *   2. 守卫边界 —— 本插件在 `agent/created` 里给每个 advisor 会话装上
 *      `ctx.tools.guard()`：除只读工具外的一切调用（包括宿主的 send_meme、
 *      plugin_manager、cordis_run、workflow…）一律拒绝。预设挂不到的工具
 *      也逃不掉，因为守卫在调用时刻拦。
 *   3. 深度边界 —— 以 maxDepth=1 启动，顾问不能再往下派子智能体。
 *
 * 开关：**由用户在开始前选择**，和「启用智能体团队协作」并排（同一个
 * `conversation.input.model.options` 槽位），默认关闭；关闭时不注册工具、
 * 不注入任何提示词，模型既看不到也不知道有这个能力。
 *
 * 状态：按会话持久化在 $DSH_HOME/dsh-advisors.json；Client 通过本插件的
 * HTTP 路由读写。选文件而不是 Session 事件的理由：插件不能 append 新的
 * 事件类型，而且「开关」是界面偏好，不是对话内容。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Loader entry id / 包名。Client bundle 的注册 id 必须与此一致。 */
export const name = 'dsh-advisors'

/**
 * 依赖的宿主服务。缺一不挂，避免在精简 profile 里炸掉。
 *
 * `llm` **故意不在这里**：它只用来给设置页发现模型，属于「锦上添花」。
 * 写进 inject 会让整个插件在 llm 缺席（或热替换的空窗期）时**完全不挂载**——
 * 连 ask_advisor、开关、只读守卫都一起没了，退化范围远大于目录不可用。
 * 所以在调用时刻用 `ctx.get('llm')` 取，取不到就报告目录不可用。
 */
export const inject = ['tools', 'subagents', 'systemPrompt', 'webServer']

/** 顾问预设 id（在 cordis.patch.yml 里用 `@deepseek-ai/dsh-agent-preset` 声明）。 */
const PRESET_ID = 'advisor'

/** Client 读写开关的同源路由。 */
const ROUTE = '/dsh-advisors-api'

/**
 * 顾问会话里唯一放行的工具。其余一切（写文件、跑命令、发图、装插件、跑代码…）
 * 都会被守卫拒绝 —— 这是「绝不能参加工作」的最后一道闸。
 */
const ADVISOR_TOOL_ALLOWLIST = new Set(['read', 'read_image', 'glob', 'grep'])

/**
 * 模型目录**不再写死**。设置页的下拉每轮向宿主的 LLM 注册表现查：
 *
 *   ctx.llm.listProviders()  →  [{ id: 'apikey', name: 'chatgpt' }, ...]
 *   ctx.llm.listModels(id)   →  [{ provider, id: 'gpt-6-astra', name: 'GPT-6 Astra' }, ...]
 *
 * 也就是说 profile 的 `llm-pi-ai.providers` 里加一条通道、或给某条通道加一个
 * 模型，下拉里立刻就有——不需要动本插件一行代码。（旧版把 8 个模型写死在
 * `MODEL_CATALOG` 里，profile 里配好的 `kele-claude` / `kele-gemini` 等通道
 * 在设置页里完全看不见，2026-11-14 主人指出的就是这个问题。）
 *
 * 下面两个常量只剩「注释」和「兜底」两个用途：
 */

/** 给已知模型补一句「为什么该选它」。纯提示，缺失不影响可用性。 */
const MODEL_NOTES = {
  'apikey/gpt-6-astra': '工程严谨、抓 bug 准',
  'apikey/gpt-6.1-sol': '同通道更强的通用档',
  'apikey/gpt-6.1-terra': '同通道另一取向',
  'apikey1/claude-opus-5-5': '审美与语义分组更强',
  'apikey1/claude-sonnet-5-5': '更快更省',
  'apikey1/claude-opus-5': '上一代',
  'apikey1/claude-sonnet-5': '上一代轻量',
  'zzz1/deepseek-v4-pro': '国内直连',
}

/**
 * 兜底目录：只在 `ctx.llm` 完全不可用时展示，标记为 `suggested`。
 * 它不是「当前可用模型」的证据——只在设置页给个参考，不参与可用性判断。
 */
const FALLBACK_CATALOG = [
  { id: 'apikey/gpt-6-astra', provider: 'apikey', providerName: 'chatgpt', model: 'gpt-6-astra', label: 'GPT-6 Astra', note: MODEL_NOTES['apikey/gpt-6-astra'] },
  { id: 'zzz1/deepseek-v4-pro', provider: 'zzz1', providerName: '中转站deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: MODEL_NOTES['zzz1/deepseek-v4-pro'] },
]

/** 目录缓存 TTL。小开关也会走 GET，别每次枚举十几条通道。 */
const CATALOG_TTL_MS = 30_000

/** 单条通道查询上限。永不完成的 listModels 不许卡死整个请求。 */
const CATALOG_QUERY_TIMEOUT_MS = 5_000

/**
 * 失败通道的冷却期。
 *
 * 注意它**比目录 TTL（30 秒）长**：意思是「一条通道坏了，接下来两轮刷新都别
 * 再为它白等 5 秒」。这不是永久拉黑——冷却到期自动重试，成功即清除；
 * 配置变化（`llm/adapters-updated`）会直接清空冷却，让刚修好的通道立刻重试。
 */
const PROVIDER_COOLDOWN_MS = 60_000

/** 超时包装：只用来让调用方先走，不取消底层请求（SDK 未必支持取消）。 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    // 不 unref：定时器在 promise 落定时就 clear，最长只活 ms，
    // 而 unref 过的定时器不会拖住事件循环 —— 会让「只有它在等」的进程提前退出。
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then((value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) })
  })
}

/**
 * 默认模型路由（用户没在设置页选过时生效）。
 * 四个领域**一律** GPT-6 Astra——2026-11-13 主人要求统一。
 */
const DEFAULT_ROUTES = {
  frontend: { provider: 'apikey', model: 'gpt-6-astra' },
  aesthetic: { provider: 'apikey', model: 'gpt-6-astra' },
  modeling: { provider: 'apikey', model: 'gpt-6-astra' },
  backend: { provider: 'apikey', model: 'gpt-6-astra' },
}

/** 兜底目录查找：`provider/model` → 目录项，找不到返回 undefined。 */
const FALLBACK_BY_ID = new Map(FALLBACK_CATALOG.map((m) => [m.id, m]))

/** 路由 → 目录 id，用于设置页回显当前值。 */
function routeIdOf(route) {
  return `${route.provider}/${route.model}`
}

/** 四个领域的中文名，仅用于工具描述与回执，给模型看。 */
const DOMAIN_LABEL = {
  frontend: '前端实现 / 组件与状态',
  aesthetic: '视觉审美 / 排版与质感',
  modeling: '数据与系统建模 / 架构',
  backend: '后端 / 数据层 / 性能与并发',
}

/** 交给顾问的任务说明：先约束输出形态，再给上下文。 */
function buildTask(domain, question) {
  return [
    `【顾问咨询 · ${domain}】${DOMAIN_LABEL[domain] ?? ''}`,
    '',
    '你收到的上下文：',
    question,
    '',
    '请只回答「该怎么做」——不要动手，不要写文件，不要执行命令。',
    '回答结构：',
    '1. 结论 / 推荐做法（先给判断，一两句话）',
    '2. 理由与权衡（备选方案为什么不行）',
    '3. 具体落地要点（关键的 API、数据结构、边界条件、顺序）',
    '4. 常见坑与验收标准',
    '工作目录与调用方共享；需要证据时用只读工具（read / glob / grep）自己查，不要凭空假设。',
  ].join('\n')
}

/** 系统提示词片段：只在开关打开时出现。领域分工由 `guidanceText()` 追加。 */
const GUIDANCE_HEAD = `Advisory consults (\`ask_advisor\`) are enabled in this session.

Consult a specialist BEFORE committing to a design when the question is about:
- \`frontend\` or \`aesthetic\` — UI implementation, component/state structure, visual taste, typography, motion, perceived quality.
- \`modeling\` — data, domain, or system modeling; architecture shape; schema and boundary design.
- \`backend\` — server, data layer, performance, concurrency, failure handling.

Advisors are read-only consultants: they may read/glob/grep this workspace for evidence, but they never edit files, run commands, or produce the implementation. Never ask an advisor to do the work; ask it what to do and why. One consult per question is enough — the advice arrives as a message, so keep working on the parts that do not depend on it and merge the advice when it lands. Do not consult for questions you can settle by reading the code yourself.`

/**
 * 读一个 agent 的委派深度。会话头是权威且单调的（恢复的子会话不会退回 0），
 * 运行时 options 只能加深。规则与 `@deepseek-ai/dsh-subagent` 的
 * `delegationDepthOf` 一致，这里内联以免多一个包依赖。
 * @param agent - 任意 agent。
 * @returns 非负整数深度；根会话为 0。
 */
function delegationDepthOf(agent) {
  const header = agent?.session?.header?.delegationDepth
  const runtime = agent?.options?.subagentDepth
  const values = [typeof header === 'number' ? header : 0, typeof runtime === 'number' ? runtime : 0]
  return Math.max(...values)
}

/** $DSH_HOME 解析：与 dsh-home-paths 同规则（配置 > 环境变量 > ~/.dsh）。 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 会话开关的持久化文件。 */
function stateFile() {
  return path.join(dshHome(), 'dsh-advisors.json')
}

/**
 * 读盘；任何异常都回落成空状态，绝不让插件因为坏文件起不来。
 *
 * `routes` 是**用户为各领域选定的模型**（`{ domain: 'provider/model' }`），
 * `sessions` 是各会话的开关。两者都必须原样带出来——早先这里只挑 `sessions`，
 * 导致设置页写入的选择在重启后被静默丢弃（坑，见 HANDOFF 第 0 节）。
 */
function loadState(logger) {
  const empty = { version: 1, sessions: {}, routes: {}, defaultEnabled: false }
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return empty
    const pick = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    const routes = {}
    for (const [domain, id] of Object.entries(pick(parsed.routes))) {
      if (typeof id === 'string' && id !== '') routes[domain] = id
    }
    return {
      version: 1,
      sessions: pick(parsed.sessions),
      routes,
      defaultEnabled: parsed.defaultEnabled === true,
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger?.warn?.(`dsh-advisors: 状态文件不可读，按「全部关闭、全部默认模型」处理：${error.message}`)
    }
    return empty
  }
}

/**
 * 写盘：先写临时文件再 rename，避免半截 JSON。
 *
 * **失败必须抛出**（2026-11-14 顾问验收指出）：曾经这里只 warn 不抛，
 * 于是磁盘满 / 权限不足 / rename 失败时，HTTP 仍回 `ok: true`——
 * 用户看到「已保存」，当前进程也暂时生效，重启后配置却没了。
 * 现在的约定是「写盘成功才算保存成功」，由调用方决定内存状态是否提交。
 *
 * @throws 写入或 rename 失败时抛原错误。
 */
function saveState(state, logger) {
  const target = stateFile()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, target)
  } catch (error) {
    logger?.warn?.(`dsh-advisors: 状态写入失败：${error && error.message}`)
    // 清掉可能的半截临时文件，别留残渣。
    try { fs.rmSync(`${target}.tmp`, { force: true }) } catch { /* 清理失败无关紧要 */ }
    throw error
  }
}

/** 是否只接受本机回环 Host（DNS rebinding 防线，和 dsh-meme 同口径）。 */
function hostIsLoopback(req) {
  const host = String(req.headers?.host ?? '')
  if (host === '') return true
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (name === 'localhost' || name === '::1' || name === '0.0.0.0') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/** 读请求体（有上限）。 */
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
 * 组装插件。
 * @param ctx - 宿主 Context。
 * @param config - 行内 config：provider / routes / providerName 等，全部可省略。
 */
export function apply(ctx, config = {}) {
  const provider = typeof config.provider === 'string' && config.provider !== '' ? config.provider : 'spawn'
  const routes = { ...DEFAULT_ROUTES }
  if (config.routes && typeof config.routes === 'object') {
    for (const [domain, route] of Object.entries(config.routes)) {
      if (route && typeof route.provider === 'string' && typeof route.model === 'string') {
        routes[domain] = { provider: route.provider, model: route.model }
      }
    }
  }

  const state = loadState(ctx.logger)

  /**
   * 最近一次现查到的目录快照。提示词段落是同步渲染的，拿不到 await 的结果，
   * 所以用它给模型名做回显；为空时退回 `FALLBACK_BY_ID`。
   */
  let lastCatalog = FALLBACK_CATALOG.map((item) => ({ ...item }))

  /** 目录缓存三件套：快照 / 过期时间 / 在途请求（single-flight）/ 失效代数。 */
  let catalogSnapshot = null
  let catalogExpiresAt = 0
  let catalogInFlight = null
  let catalogGeneration = 0

  /** 失败通道的冷却表：providerId → 冷却截止时间戳。 */
  const providerCooldown = new Map()

  /** `provider/model` → 展示名。先查快照，再查兜底，最后原样返回 id。 */
  const labelOf = (id) => {
    const live = lastCatalog.find((item) => item.id === id)
    if (live !== undefined) return live.label
    const known = FALLBACK_BY_ID.get(id)
    return known === undefined ? id : known.label
  }

  // 会话可能有显式值；没有时回落到全局默认（设置页的「新会话默认开启」）。
  const enabledOf = (sessionId) => {
    const saved = sessionId === undefined ? undefined : state.sessions[sessionId]?.enabled
    return typeof saved === 'boolean' ? saved : state.defaultEnabled === true
  }

  /**
   * 统一的「先落盘、后提交内存」写入。
   *
   * 候选状态用浅拷贝构造，写盘成功才替换 `state` 的字段；失败则原状态不动、
   * 错误向上抛（由 HTTP 层回 500）。这样「接口说成功」和「重启后还在」是同一件事。
   *
   * @param mutate - 接收候选状态并就地修改。
   */
  const commitState = (mutate) => {
    const candidate = {
      version: 1,
      sessions: { ...state.sessions },
      routes: { ...state.routes },
      defaultEnabled: state.defaultEnabled === true,
    }
    mutate(candidate)
    saveState(candidate, ctx.logger) // 失败会抛，内存状态保持原样
    state.sessions = candidate.sessions
    state.routes = candidate.routes
    state.defaultEnabled = candidate.defaultEnabled
  }

  const setEnabled = (sessionId, enabled) => {
    commitState((next) => {
      next.sessions[sessionId] = { enabled, updatedAt: Date.now() }
    })
  }
  const setDefaultEnabled = (enabled) => {
    commitState((next) => { next.defaultEnabled = enabled })
  }

  /** 用户为某领域选定的模型 id（形如 `apikey/gpt-6-astra`），没有返回 undefined。 */
  const selectedIdOf = (domain) => {
    const saved = state.routes?.[domain]
    return typeof saved === 'string' && saved !== '' ? saved : undefined
  }

  /**
   * 解析某领域最终生效的路由，优先级：
   *   1. 用户设置页的选择（dsh-advisors.json 的 routes）
   *   2. 插件 config 的 routes（cordis.patch.yml 覆盖）
   *   3. DEFAULT_ROUTES
   * 目录里查不到的 id 也接受——它可能来自 profile 里新增、目录尚未收录的模型。
   */
  const routeOf = (domain) => {
    const chosen = selectedIdOf(domain)
    if (chosen !== undefined) {
      const item = FALLBACK_BY_ID.get(chosen)
      if (item !== undefined) return { provider: item.provider, model: item.model }
      const slash = chosen.indexOf('/')
      if (slash > 0) {
        return { provider: chosen.slice(0, slash), model: chosen.slice(slash + 1) }
      }
    }
    return routes[domain] ?? DEFAULT_ROUTES[domain]
  }

  /** 当前四个领域的生效路由（设置页与工具回执共用）。 */
  const effectiveRoutes = () => {
    const out = {}
    for (const domain of Object.keys(routes)) out[domain] = routeOf(domain)
    return out
  }

  /**
   * 写入某领域的模型选择；null 表示清除选择、回退默认。
   * 落盘失败会抛（不返回 true），HTTP 层据此回 500，不谎报成功。
   * @returns 是否写入成功。
   */
  const setDomainRoute = (domain, modelId) => {
    if (routes[domain] === undefined && DEFAULT_ROUTES[domain] === undefined) return false
    commitState((next) => {
      if (modelId === null || modelId === '') delete next.routes[domain]
      else next.routes[domain] = String(modelId)
    })
    return true
  }

  /** 一个会话是否开启：以它所在子智能体树的根为准，和 Agent Teams 同语义。 */
  const enabledForAgent = (agent) => {
    if (agent === undefined) return false
    let rootId
    try {
      rootId = ctx.subagents.rootOf(agent).session.id
    } catch {
      rootId = agent.session.id
    }
    return enabledOf(rootId) || enabledOf(agent.session.id)
  }

  /** 轻量状态：只有开关，**完全不碰 LLM**。模型菜单里那一行开关走这个。 */
  const stateView = () => ({
    defaultEnabled: state.defaultEnabled === true,
    domains: Object.keys(routes).map((domain) => ({
      domain,
      label: DOMAIN_LABEL[domain] ?? domain,
      selected: selectedIdOf(domain) ?? null,
      effective: routeIdOf(routeOf(domain)),
    })),
  })

  /**
   * 设置页要的全部数据：可选模型目录 + 每领域当前生效值 + 用户是否显式选过。
   *
   * 目录走缓存（`catalogCache()`），所以 profile 里新加的通道/模型不用改插件，
   * 也不会让每次 GET 都枚举十几条通道。唯一写死的是每个模型那句 `note`。
   *
   * `domains[].availability` 让 UI 能区分「目录里有」和「目录里没有」，
   * 但**不自动改用户的配置**：目录枚举不等于执行能力探测，暂时失败的通道
   * 也会缺席，贸然清掉选择比留着更糟。
   */
  const catalogView = async () => {
    const { catalog, status, failedProviders, fetchedAt } = await catalogCache()
    const listed = new Set(catalog.map((item) => item.id))
    // 目录不可用时，所有选择都是「不知道」而不是「不存在」。
    const availabilityOf = (id) => {
      if (id === null) return 'unknown'
      if (status === 'unavailable') return 'unknown'
      if (listed.has(id)) return 'listed'
      return status === 'partial' ? 'unknown' : 'missing'
    }
    return {
      ...stateView(),
      catalog,
      catalogMeta: { status, failedProviders, fetchedAt: fetchedAt ?? null },
      domains: Object.keys(routes).map((domain) => {
        const selected = selectedIdOf(domain) ?? null
        const effective = routeIdOf(routeOf(domain))
        return {
          domain,
          label: DOMAIN_LABEL[domain] ?? domain,
          selected,
          effective,
          // 判断的是**生效路由**而不是显式选择：没选过的领域用的是默认模型，
          // 那个默认模型同样可能已经不在目录里，UI 需要能看见。
          availability: availabilityOf(effective),
        }
      }),
    }
  }

  /**
   * 向宿主 LLM 注册表现查「现在真的能路由的模型」。
   *
   * 三条纪律（都是顾问指出的真实风险）：
   *   1. `ctx.get('llm')` 而不是 `ctx.llm` —— llm 不在 inject 里，缺席时插件仍要活着；
   *   2. 每条通道并发查、各自 catch —— 一条挂了只丢它自己；
   *   3. 永不完成的调用**不能**卡死请求：整体套超时，超时的那批按失败记。
   *
   * 结果同时更新 `lastCatalog`（提示词同步渲染时要用）与缓存时间戳。
   * @returns {{ catalog: Array, status: 'fresh'|'partial'|'unavailable', failedProviders: string[] }}
   */
  const liveCatalog = async (generation) => {
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') {
      return { catalog: [], status: 'unavailable', failedProviders: [] }
    }
    let providers
    try {
      // 宿主当前实现是纯同步的内存映射（`[...adapters.values()].map(...)`），
      // 不会挂死；但这里仍套一层超时 + await，万一将来换成异步枚举也不会拖死请求。
      providers = await withTimeout(
        Promise.resolve(llm.listProviders()),
        CATALOG_QUERY_TIMEOUT_MS,
        '读 provider 列表超时',
      )
    } catch (error) {
      ctx.logger?.warn?.(`dsh-advisors: 读 provider 列表失败：${error && error.message}`)
      return { catalog: [], status: 'unavailable', failedProviders: [] }
    }
    if (!Array.isArray(providers)) return { catalog: [], status: 'unavailable', failedProviders: [] }

    const failedProviders = []
    const now = Date.now()
    const groups = await Promise.all(providers.map(async (p) => {
      const providerId = typeof p?.id === 'string' ? p.id : ''
      if (providerId === '') return []
      const rawName = typeof p?.name === 'string' ? p.name.trim() : ''
      const providerName = rawName === '' ? providerId : rawName
      /**
       * 冷却表的**修改**只允许当前 generation；旧代可以**读取**，但读取仅影响
       * 它自己那一轮的结果，不会写回共享状态。
       *
       * 顾问审出的真实竞态：旧一代的请求在配置更新后才失败，会把**已经修好的**
       * 通道重新打进冷却；反方向也成立（旧代迟到成功会清掉新代设的冷却）。
       * 所以 set / delete 都必须在异步返回后、紧邻调用处求值 isCurrent()。
       */
      const isCurrent = () => generation === catalogGeneration
      // 短期退避：刚超时过的通道在冷却期内直接跳过，不再让它把整轮拖慢 5 秒。
      // 目录是「锦上添花」，为一条坏通道反复付出 5 秒不值得。
      const coolUntil = providerCooldown.get(providerId)
      if (coolUntil !== undefined && now < coolUntil) {
        failedProviders.push(providerId)
        return []
      }
      try {
        const models = await withTimeout(
          Promise.resolve(llm.listModels(providerId)),
          CATALOG_QUERY_TIMEOUT_MS,
          `通道 ${providerId} 的模型列表超时`,
        )
        if (isCurrent()) providerCooldown.delete(providerId)
        return (Array.isArray(models) ? models : [])
          .filter((m) => typeof m?.id === 'string' && m.id !== '')
          .map((m) => {
            const id = `${providerId}/${m.id}`
            return {
              id,
              provider: providerId,
              providerName,
              model: m.id,
              label: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
              note: MODEL_NOTES[id] ?? '',
            }
          })
      } catch (error) {
        failedProviders.push(providerId)
        if (isCurrent()) providerCooldown.set(providerId, Date.now() + PROVIDER_COOLDOWN_MS)
        ctx.logger?.warn?.(`dsh-advisors: 通道 ${providerId} 的模型列表读不到，已跳过：${error && error.message}`)
        return []
      }
    }))
    const catalog = groups.flat()
    return {
      catalog,
      status: catalog.length === 0 ? 'unavailable' : failedProviders.length > 0 ? 'partial' : 'fresh',
      failedProviders,
    }
  }

  /**
   * 带缓存与 single-flight 的目录读取。
   *
   * 为什么不每次 GET 都现查：小开关（模型菜单里那一行）只需要一个布尔值，
   * 却会连带枚举十几条通道。缓存 30 秒 + 并发请求共享同一个 in-flight
   * Promise，够用且简单。`llm/adapters-updated` 事件到了就作废缓存。
   *
   * 三条纪律（顾问复检后补的，都是真实 bug）：
   *   1. **先归一化再缓存**。曾经把空目录写进快照、只把本次返回值换成兜底：
   *      第一次 GET 显示建议目录，第二次直接变空。
   *   2. **inFlight 带 generation 身份**。失效后只共享同一代的任务；
   *      旧一代的结果不得写快照、不得更新 lastCatalog、不得清掉新一代的 inFlight。
   *   3. **fetchedAt 随结果走**，不从 catalogExpiresAt 反推（失效期会算出 null，
   *      异常分支会冒用上一轮时间）。
   */
  const catalogCache = async () => {
    const now = Date.now()
    if (catalogSnapshot !== null && now < catalogExpiresAt) return catalogSnapshot
    // 只复用同一代的在途请求；旧一代的已经不可信。
    if (catalogInFlight !== null && catalogInFlight.generation === catalogGeneration) {
      return catalogInFlight.promise
    }
    const generation = catalogGeneration
    const pending = liveCatalog(generation).then((raw) => {
      // 归一化：unavailable 的空目录换成建议目录。这一步必须在写快照**之前**，
      // 否则缓存里存的是空数组、返回给调用方的是兜底，两次 GET 结果不一致。
      const normalized = raw.status === 'unavailable' && raw.catalog.length === 0
        ? { ...raw, catalog: FALLBACK_CATALOG.map((item) => ({ ...item })) }
        : raw
      const result = { ...normalized, fetchedAt: Date.now() }
      // 旧一代的结果：不写快照、不动 lastCatalog，直接返回（本次调用方仍可用）。
      if (generation !== catalogGeneration) return result
      catalogSnapshot = result
      catalogExpiresAt = Date.now() + CATALOG_TTL_MS
      // 提示词是同步渲染的，只能读 lastCatalog。真实目录到手就更新它
      // （部分通道失败也更新），这样提示词里的模型名和设置页一致；
      // 全失败则保留上一次已知结果，不去编造兜底名字。
      if (result.status !== 'unavailable' && result.catalog.length > 0) lastCatalog = result.catalog
      return result
    }, (error) => {
      ctx.logger?.warn?.(`dsh-advisors: 目录读取异常：${error && error.message}`)
      return {
        catalog: FALLBACK_CATALOG.map((item) => ({ ...item })),
        status: 'unavailable',
        failedProviders: [],
        fetchedAt: Date.now(),
      }
    })
    const record = { generation, promise: pending }
    catalogInFlight = record
    // 只有「这一轮仍是在途记录」时才清空：旧任务结束时不许清掉新一代的任务。
    const settle = () => { if (catalogInFlight === record) catalogInFlight = null }
    pending.then(settle, settle)
    return pending
  }

  /** 作废缓存：宿主适配器拓扑变了（profile 加/删通道、模型）。 */
  const invalidateCatalog = () => {
    catalogGeneration += 1
    catalogSnapshot = null
    catalogExpiresAt = 0
    // 配置/适配器变了，旧的失败判断不再适用：清掉冷却，让刚修好的通道立刻有机会重试。
    // 不清的话，改完 profile 还要白等最多 60 秒（冷却）+ 30 秒（旧 partial 快照）。
    providerCooldown.clear()
    // 不在这里清 inFlight：它的 generation 已经不匹配，新请求自然不会复用它；
    // 由它自己的 settle 收尾，避免旧任务把新一代的记录清掉。
  }
  ctx.on('llm/adapters-updated', invalidateCatalog)

  // ---------------------------------------------------------------- HTTP 开关路由
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler(req, res) {
      if (!hostIsLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '只接受本机请求' }))
        return
      }
      const method = String(req.method ?? 'GET').toUpperCase()
      const url = new URL(String(req.url ?? ROUTE), 'http://127.0.0.1')

      /**
       * 安全回应：先序列化再写头，并且**绝不二次写**。
       * 异步分支里 respond 可能在客户端已断开、或异常处理里被再调一次；
       * 那时 writeHead 会抛 ERR_STREAM_ALREADY_FINISHED / ERR_HTTP_HEADERS_SENT。
       */
      const respond = (status, value) => {
        let payload
        try {
          payload = JSON.stringify(value)
        } catch (error) {
          payload = JSON.stringify({ ok: false, error: `序列化失败：${error && error.message}` })
          status = 500
        }
        try {
          if (res.writableEnded === true || res.destroyed === true) return
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(payload)
        } catch {
          // 连接已经没了：响应写不出去不是插件的错误，静默收场。
        }
      }

      /** 异步分支的统一外壳：同步入口 + 自带最终兜底，绝不产生未捕获拒绝。 */
      const runAsync = (task) => {
        void Promise.resolve()
          .then(task)
          .catch((error) => {
            ctx.logger?.warn?.(`dsh-advisors: 请求处理失败：${error && error.message}`)
            respond(500, { ok: false, error: error && error.message ? error.message : String(error) })
          })
      }

      if (method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        // 轻量分支：模型菜单里那一行开关只要一个布尔值，不该为它枚举十几条通道。
        if (url.searchParams.get('view') === 'state') {
          respond(200, { ok: true, enabled: enabledOf(sessionId), ...stateView() })
          return
        }
        runAsync(async () => {
          const view = await catalogView()
          respond(200, { ok: true, enabled: enabledOf(sessionId), ...view })
        })
        return
      }
      if (method === 'POST') {
        runAsync(async () => {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            // 请求体坏了是调用方的错，400；不要被外层兜成 500。
            respond(400, { ok: false, error: error && error.message ? error.message : String(error) })
            return
          }
          // JSON 的 null / 数组 / 标量都能被 JSON.parse 成功解析出来，
          // 之后访问 body.domain 会抛 TypeError 被兜成 500。这里统一挡成 400。
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            respond(400, { ok: false, error: '请求体必须是一个 JSON 对象' })
            return
          }
          // 分支一：写某领域的模型选择。
          if (typeof body.domain === 'string' && body.domain !== '') {
            const modelId = body.modelId === null || body.modelId === undefined
              ? null
              : String(body.modelId)
            // 只按**第一个** `/` 切分，和 routeOf() 完全一致。
            // 旧正则要求整串恰好一个斜杠，会拒绝 `provider/org/model` 这种
            // 真实的模型 id（目录能列出、却存不进去）。
            if (modelId !== null) {
              const slash = modelId.indexOf('/')
              if (slash <= 0 || slash === modelId.length - 1 || /\s/.test(modelId)) {
                respond(400, { ok: false, error: 'modelId 需要形如 "provider/model"' })
                return
              }
            }
            if (!setDomainRoute(body.domain, modelId)) {
              respond(400, { ok: false, error: `未知领域 "${body.domain}"` })
              return
            }
            // 写入已经完成。**不要 await 目录**：保存动作不该等最慢通道那 5 秒，
            // 而且目录查询失败也不该让一次成功的写入回报失败。
            // 客户端拿到 stateView 后自行决定是否刷新目录。
            respond(200, {
              ok: true,
              domain: body.domain,
              selected: modelId,
              effective: routeIdOf(routeOf(body.domain)),
              ...stateView(),
            })
            return
          }
          // 分支二：写全局默认（新会话默认是否开启）。
          if (typeof body.defaultEnabled === 'boolean') {
            setDefaultEnabled(body.defaultEnabled)
            respond(200, { ok: true, ...stateView() })
            return
          }
          // 分支三：写会话开关。
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '' || typeof body.enabled !== 'boolean') {
            respond(400, { ok: false, error: '需要 { sessionId, enabled }、{ domain, modelId } 或 { defaultEnabled }' })
            return
          }
          setEnabled(sessionId, body.enabled)
          respond(200, { ok: true, enabled: body.enabled })
        })
        return
      }
      respond(405, { ok: false, error: 'method not allowed' })
    },
  }), 'dsh-advisors: toggle route')

  // ---------------------------------------------------------------- 只读守卫
  // 预设已经写不出文件；这两道闸负责把宿主级工具（send_meme / plugin_manager /
  // cordis_run / workflow / schedule / subagent…）一并挡在顾问门外。
  //
  // 为什么是两道：
  //   1. `restrict({ allow: [...ADVISOR_TOOL_ALLOWLIST] })` —— 声明式硬边界。
  //      restrict 同时作用于 view() 与 executable()，是**执行级**拦截，
  //      不是只把 schema 藏起来；非白名单工具既不可见、也调不动。
  //   2. `guard(deny)` —— 调用期兜底，给出可读的中文拒绝理由。
  //
  // 注意别再改回 `allow: []`：那会把四个只读工具一起掐掉（实测工具面变 0），
  // 因为它们是 bundle 级插件注册在全局层的，不在 agent 自己的 scope 里。
  // 详见 installAdvisorGuard 上的注释。
  const guardDeny = (execution) => (ADVISOR_TOOL_ALLOWLIST.has(execution.name)
    ? undefined
    : `顾问会话只回答问题、不参与实施：\`${execution.name}\` 在顾问会话里被禁用。`
      + ' 需要动手的部分请交回主智能体。')

  /**
   * 存活顾问的保护记录。卸载/热重载时不能只把守卫摘掉就走——那样顾问会带着
   * 「全量宿主工具」继续跑到本轮结束（裸奔窗口）。这里记着它们的身份与卸载器，
   * 让插件卸载时能先中止顾问、再摘守卫。
   */
  const liveAdvisors = new Map()

  /**
   * 尝试中止一个顾问，返回是否**确实**建立了终止边界。
   *
   * 为什么不能只调 cancel 就当成功：`agent-loop` 的 `cancel(cause)` 是
   * `if (this.phase.kind !== "idle") abort()`。而 `agent/created` 阶段顾问通常
   * 还是 idle，此时 cancel 只清空 inbox、不做 abort；紧接着宿主的
   * `wakeDriver()` 从 idle 直接 `setPhase({kind:"running"})` 开跑。
   * 也就是说 **idle 时 cancel 阻止不了它继续跑**，返回 true 会是假中止。
   *
   * 所以这里显式看 status：只有真的 running 才认为 cancel 有意义。
   */
  const abortAdvisor = (agent) => {
    if (agent?.status !== 'running') return false
    try {
      agent.cancel({ kind: 'user' })
      return true
    } catch (error) {
      ctx.logger?.warn?.(`dsh-advisors: 中止顾问失败：${error && error.message}`)
      return false
    }
  }

  /**
   * 装上只读工具面。
   *
   * 这里踩过一个真机才暴露的坑：最初写的是 `restrict({ allow: [] })`，依据是
   * dsh-tools 的 view() 里「own scope 的工具在 restrictions 之后被无条件
   * visible.set」。但真机实测（会话 8e83baa6）工具清单直接变成 **0 个**——
   * 因为顾问预设的 read/read_image/glob/grep 是 bundle 级插件注册进**全局层**
   * 的，own 是空的，这些工具全在 inherited 里，被 allow:[] 一并掐掉。
   *
   * 所以改成精确白名单：只允许 ADVISOR_TOOL_ALLOWLIST 里那几个名字。
   * restrict() 的 unknown 检查会拿 restrictableNames（= 全局已知名字）校验，
   * 名字不存在会抛错 → 走下面的失败分支，而不是静默放开。
   */
  const installAdvisorGuard = (agent) => {
    let releaseRestrict
    let disposeGuard
    let strict = true
    try {
      releaseRestrict = agent.ctx.tools.restrict({ allow: [...ADVISOR_TOOL_ALLOWLIST] })
    } catch (error) {
      // 精确白名单装不上（例如某个名字这一版没挂）。这通常意味着工具面
      // 已经不是预期形状，继续跑就是「看得见但调不动」的空耗，因此按
      // fail-closed 处理，不要在启动时静默降级。
      strict = false
      releaseRestrict = undefined
      ctx.logger?.warn?.(`dsh-advisors: 顾问工具白名单安装失败：${error && error.message}`)
    }
    if (strict) {
      try {
        disposeGuard = agent.ctx.tools.guard(guardDeny)
      } catch (error) {
        strict = false
        disposeGuard = undefined
        ctx.logger?.warn?.(`dsh-advisors: 顾问工具守卫安装失败：${error && error.message}`)
      }
    }
    if (strict) {
      // agent.id 与 session.id 恒等（dsh-agent 的 enter() 会校验），
      // 不写 `?? session.id` 的兜底：那会把生命周期异常静默掩盖成两个键。
      liveAdvisors.set(agent.id, { agent, releaseRestrict, disposeGuard })
      return true
    }
    // ---- fail-closed ----
    // 先撤掉可能已经装上的保护（反正这个顾问不该继续活着），再阻止它启动。
    // 顺序上「撤保护」在前是安全的：下面会确保它根本进不了执行状态。
    try { disposeGuard?.() } catch { /* 尽力回滚 */ }
    try { releaseRestrict?.() } catch { /* 同上 */ }
    if (!abortAdvisor(agent)) {
      // idle 状态 cancel 拦不住，必须让 agent 注册本身失败。
      // dsh-agent register() 明确「serial agent/created listener fails」即拒绝注册，
      // 所以这里抛出去才能真正阻止顾问进入模型步。
      throw new Error('dsh-advisors: 无法为顾问建立只读工具边界，已拒绝启动该顾问会话')
    }
    ctx.logger?.warn?.('dsh-advisors: 顾问只读边界建立失败，已中止运行中的顾问')
    return false
  }

  // agent 自己销毁时把记录清掉，避免 liveAdvisors 无限增长。
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id !== undefined) liveAdvisors.delete(agent.id)
  })

  ctx.on('agent/created', ({ agent }) => {
    if (agent?.session?.header?.agentPreset !== PRESET_ID) return
    // 宿主的 agent/created 是 await ctx.serial() 发出的串行事件，
    // 监听器返回前不会进入模型步，所以这里同步装完即对首次调用生效；
    // 同理，这里抛错会让 agent 注册失败（见 dsh-agent register() 的契约）。
    installAdvisorGuard(agent)
  })

  // 插件卸载 / 热重载：先确保顾问不会再执行，再摘守卫。
  // 顺序不能反——先摘守卫会留下一个可执行的无保护窗口。
  ctx.effect(() => () => {
    // 快照迭代：cancel 可能触发 agent/disposed 回调去改 liveAdvisors，
    // 实时迭代会漏掉尚未访问的记录。
    for (const [key, record] of [...liveAdvisors]) {
      // 中止失败（多半是 idle）时不能乐观地撤掉保护：保留守卫直到 agent
      // 自己 disposed。插件已卸载，这些 disposer 仍有效——它们绑在
      // agent 的 scope 上，agent 销毁时宿主会一并清理。
      if (!abortAdvisor(record.agent)) {
        ctx.logger?.warn?.('dsh-advisors: 插件卸载时顾问未处于运行态，保留其只读守卫直到会话结束')
        liveAdvisors.delete(key)
        continue
      }
      try { record.disposeGuard() } catch { /* 已被 agent 销毁时幂等忽略 */ }
      try { record.releaseRestrict() } catch { /* 同上 */ }
      liveAdvisors.delete(key)
    }
  }, 'dsh-advisors: advisor guards teardown')


  // ---------------------------------------------------------------- 工具 + 提示词
  /**
   * 提示词正文：把「当前每个领域实际跑哪个模型」写进去，模型才知道
   * 哪个领域该问谁（用户可以在设置页把 aesthetic 换成 Claude）。
   * 每次组装时读一次，设置页改完下一轮就生效。
   */
  const guidanceText = () => {
    const lines = []
    for (const domain of Object.keys(effectiveRoutes())) {
      const route = routeOf(domain)
      const id = routeIdOf(route)
      lines.push(`- \`${domain}\` — ${labelOf(id)} (${id})`)
    }
    return `${GUIDANCE_HEAD}

Current domain → model assignment (change it in Settings → Advisors):
${lines.join('\n')}`
  }

  ctx.systemPrompt.section({
    name: 'tool:ask_advisor',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ agent }) => (enabledForAgent(agent) ? guidanceText() : ''),
  })

  ctx.tools.register(defineTool({
    name: 'ask_advisor',
    description: 'Consult a read-only specialist subagent that runs on a different, stronger model for its '
      + 'domain, and returns methods and advice only. Use it before committing to a UI/aesthetic design, a '
      + 'modeling or architecture decision, or a backend design, when a second expert opinion is worth the '
      + 'round trip. The advisor can read, glob, and grep this workspace for evidence, but it never edits '
      + 'files, runs commands, or performs the work: ask it what to do and why, then implement it yourself. '
      + 'It starts a managed subagent and returns immediately; the advice arrives later as a message from '
      + 'that subagent.',
    parameters: {
      domain: {
        type: 'string',
        required: true,
        enum: Object.keys(effectiveRoutes()),
        description: 'Which specialist to consult: frontend/aesthetic for UI and visual decisions, modeling '
          + 'for data and architecture, backend for servers, data layers, performance, and concurrency. '
          + 'Each domain runs on the model the user assigned to it in settings.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The complete question, including the concrete situation: what is being built, the '
          + 'relevant files or symbols, the options under consideration, and the constraints. The advisor '
          + 'does not share this conversation, so state everything it needs.',
      },
      name: {
        type: 'string',
        description: 'Optional short name for the advisor subagent: lower-case letters, digits, and hyphens, '
          + 'starting with a letter, at most 32 characters.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'advisor-activation' },
          name: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `started advisor ${value.name} (${value.domain} · ${value.provider}/${value.model})`,
      }],
      presentationMeta: (_args, value) => ({
        kind: value.kind,
        name: value.name,
        domain: value.domain,
        model: value.model,
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('ask_advisor requires a calling agent')
      const route = routeOf(args.domain)
      if (route === undefined) {
        throw new Error(`unknown advisor domain "${args.domain}"; available: ${Object.keys(effectiveRoutes()).join(', ')}`)
      }
      // 顾问的深度上限 = 父深度 + 1：刚好容许「主智能体 → 顾问」和
      // 「子智能体 → 顾问」，但顾问自己（父深度 + 1）再往下派就超限。
      const advisorMaxDepth = delegationDepthOf(parent) + 1
      const started = await ctx.subagents.startActivation({
        provider,
        label: `${args.domain} advisor`,
        ...(args.name === undefined ? {} : { name: args.name }),
        prompt: [{ type: 'text', text: buildTask(args.domain, args.question) }],
        parent,
        agentPreset: PRESET_ID,
        agentOptions: { provider: route.provider, model: route.model },
        maxDepth: advisorMaxDepth,
        signal: exec.signal,
        delivery: 'parent',
      })
      return {
        kind: 'advisor-activation',
        name: started.name,
        domain: args.domain,
        provider: route.provider,
        model: route.model,
      }
    },
  }), { when: ({ agent }) => enabledForAgent(agent) })
}
