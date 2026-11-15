/**
 * dsh-advisors —— Client 半边。
 *
 * 两件事：
 *   1. 在「模型 / 推理等级」菜单里，紧挨着「启用智能体团队协作」加一个
 *      「启用只读顾问」开关（`conversation.input.model.options` 槽位）。
 *   2. 在设置里注册一个「顾问」页（`settings.section` 槽位）：给四个领域
 *      分别挑模型，并设置「新会话默认开启」。
 *
 * 两边状态都存在宿主侧（$DSH_HOME/dsh-advisors.json），通过本插件的
 * `/dsh-advisors-api` 同源路由读写 —— 与 dsh-meme 同款做法：不走 Session 事件，
 * 因为这是界面偏好而不是对话内容，而且插件不允许 append 新事件类型。
 *
 * 注意：本文件是手写的 `__ModuleLoader__` bundle，**不能** require 宿主的
 * `@deepseek-ai/dsh-client-ui-primitives`（那些包会变，抛错会让整个 slot entry
 * 崩掉）。控件全部自己写，样式只用 `--dsw-alias-*` 主题 token，类名一律
 * `dsh-advisors-` 前缀。
 */
window.__ModuleLoader__.load({
  id: 'dsh-advisors',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 同 dsh-meme：从加载本 bundle 的 <script src> 反推子路径部署前缀。 */
    const detectAppBase = (doc) => {
      if (!doc) return ''
      const fromPath = (p) => {
        const m = /^(.*?)\/plugins\//.exec(String(p || ''))
        return m ? String(m[1]).replace(/\/+$/, '') : null
      }
      try {
        const src = doc.currentScript && doc.currentScript.src
        if (src) {
          const base = fromPath(new URL(src, doc.baseURI || location.href).pathname)
          if (base !== null) return base
        }
      } catch (e) { /* 非浏览器 */ }
      try {
        for (const el of doc.querySelectorAll('script[src]')) {
          const base = fromPath(new URL(el.src, doc.baseURI || location.href).pathname)
          if (base !== null) return base
        }
      } catch (e) { /* 极简 DOM */ }
      return ''
    }
    const APP_BASE = detectAppBase(typeof document === 'undefined' ? null : document)
    const absAppPath = (u) => {
      const s = String(u == null ? '' : u)
      if (!s || s[0] !== '/' || s[1] === '/') return s
      if (!APP_BASE || s === APP_BASE || s.indexOf(APP_BASE + '/') === 0) return s
      return APP_BASE + s
    }

    const NS = 'dsh-advisors'
    const API = '/dsh-advisors-api'
    const SECTION_ID = 'dsh-advisors'

    /** 语言包。键名与下面 t() 调用一一对应。 */
    const zh = {
      'mode.label': '启用只读顾问',
      'mode.description': '遇到前端审美、建模或后端设计问题时，可临时询问只读顾问。顾问是只读子智能体：能读代码查证据，但只给方法和建议，绝不改文件、不跑命令。会额外消耗 token。',
      'mode.infoLabel': '关于只读顾问',
      'mode.loading': '读取顾问开关…',
      'mode.failed': '无法保存顾问开关，请重试：{message}',
      // 状态走 ⓘ 气泡，不再占标题行 —— 长句挤在行内会把标签压成一字一行。
      'mode.approx': '当前：默认关闭。开启后本次会话可用 ask_advisor。',
      'section.label': '顾问',
      'page.title': '只读顾问',
      'page.intro': '顾问是只读子智能体：能读代码查证据，但只给方法和建议，绝不改文件、不跑命令。这里决定每个领域用哪个模型，以及新会话是否默认开启。',
      'page.loading': '读取顾问设置…',
      'page.retry': '重试',
      'page.failed': '读取顾问设置失败：{message}',
      'page.saveFailed': '保存失败，请重试：{message}',
      'page.defaultLabel': '新会话默认开启',
      'page.defaultHint': '开启后，新会话不必每次在模型菜单里手动打开。已有会话保留各自的选择。',
      'page.domainHeader': '每个领域的模型',
      'page.domainHint': '同一个问题该问谁不一样：工程审稿和审美判断不该由同一个模型下结论。改动立即生效，下一轮对话即使用新模型。',
      'page.effectivePrefix': '当前生效',
      'page.followDefault': '跟随默认（{model}）',
      'page.followDefaultShort': '跟随默认',
      'page.followDefaultNote': '当前：{model} · 默认配置变化时自动跟随',
      'page.searchPlaceholder': '搜索模型或通道…',
      'page.searchLabel': '{domain}：搜索模型',
      'page.noMatch': '没有匹配的模型',
      'page.outsideCatalog': '目录外',
      'page.outsideCatalogNote': '目录里没有这个模型，可能是通道暂时不可用或已删除',
      'page.writableHint': '下拉选项是实时从宿主的模型注册表现查的：profile 的 llm-pi-ai 里加了通道或模型，这里刷新后就能选。',
      'page.saved': '已保存',
    }
    const en = {
      'mode.label': 'Enable read-only advisors',
      'mode.description': 'For UI taste, modeling, and backend design questions, consult a read-only advisor. Advisors are read-only subagents: they may read the code for evidence, but they only return methods and advice — they never edit files or run commands. Costs extra tokens.',
      'mode.infoLabel': 'About read-only advisors',
      'mode.loading': 'Reading advisor setting…',
      'mode.failed': 'Could not save the advisor setting. Try again: {message}',
      'mode.approx': 'Now: off by default. When on, ask_advisor is available in this session.',
      'section.label': 'Advisors',
      'page.title': 'Read-only advisors',
      'page.intro': 'An advisor is a read-only subagent: it may read the code for evidence, but it only returns methods and advice — it never edits files or runs commands. This page picks the model behind each domain and whether new sessions start with advisors on.',
      'page.loading': 'Reading advisor settings…',
      'page.retry': 'Retry',
      'page.failed': 'Could not read advisor settings: {message}',
      'page.saveFailed': 'Could not save. Try again: {message}',
      'page.defaultLabel': 'On by default in new sessions',
      'page.defaultHint': 'When on, new sessions do not need the model menu toggle. Existing sessions keep their own choice.',
      'page.domainHeader': 'Model per domain',
      'page.domainHint': 'The right expert differs by question: engineering review and aesthetic judgement should not be settled by the same model. Changes apply immediately, from the next turn.',
      'page.effectivePrefix': 'In effect',
      'page.followDefault': 'Follow default ({model})',
      'page.followDefaultShort': 'Follow default',
      'page.followDefaultNote': 'Now: {model} · follows the default when it changes',
      'page.searchPlaceholder': 'Search models or providers…',
      'page.searchLabel': '{domain}: search models',
      'page.noMatch': 'No matching model',
      'page.outsideCatalog': 'Outside catalog',
      'page.outsideCatalogNote': 'This model is not in the catalog — its provider may be temporarily unavailable or the model was removed',
      'page.writableHint': 'The list is read live from the host model registry: add a provider or model in the profile’s llm-pi-ai config and it appears here after a refresh.',
      'page.saved': 'Saved',
    }

    /** 迷你插值：只支持 {name} 形式，够用。 */
    const format = (template, values) => String(template).replace(/\{(\w+)\}/g,
      (whole, key) => (values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole))

    /**
     * 样式逐条对齐宿主的「启用智能体团队协作」那行（agent-team 的
     * TeamModeToggle.module.css）。
     *
     * 教训（2026-11-14，截图实证）：原来把 `mode.approx` 那句长说明塞在
     * label 里，标签本身顶着 `min-width:0`，长句 `white-space:nowrap` 又抢空间，
     * 结果「启用只读顾问」被压成一字一行、开关被挤出视野。宿主的做法是
     * **行内只有名称 + ⓘ 图标**，说明全部走 Tooltip；这里照抄那个结构。
     */
    const CSS = `
.dsh-advisors-row{position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:34px;padding:0 8px;border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-advisors-label{display:inline-flex;align-items:center;gap:4px;min-width:0}
.dsh-advisors-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-advisors-info{position:relative;z-index:1;flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));cursor:pointer}
.dsh-advisors-info:hover{color:var(--dsw-alias-label-primary)}
.dsh-advisors-info:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-advisors-switch{position:static;box-sizing:border-box;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
/* 点击区扩到整行 —— **只能限定在模型菜单那一行里**。
 * 这个伪元素是 position:absolute;inset:0，而开关本身是 position:static：
 * 一旦祖先里没有定位元素，包含块就会一路上溯到宿主的设置面板容器，
 * 变成一张覆盖整个设置页的透明遮罩，把所有点击都吃掉
 * （2026-11-14 主人实测：打开顾问设置页后点哪都没反应，只能点外面退出）。
 * 设置页的开关没有 .dsh-advisors-row 祖先，所以这里加前缀就把它排除了。 */
.dsh-advisors-row .dsh-advisors-switch:after{content:"";position:absolute;inset:0;border-radius:var(--dsw-radius-md,8px)}
.dsh-advisors-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsh-advisors-switch:disabled{cursor:default;opacity:.5}
.dsh-advisors-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-advisors-switch[aria-checked=false] .dsh-advisors-switch-thumb{background:var(--dsw-alias-switch-thumb)}
.dsh-advisors-switch[aria-checked=true] .dsh-advisors-switch-thumb{transform:translate(16px)}
.dsh-advisors-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.dsh-advisors-row:has(.dsh-advisors-switch:focus-visible){background:var(--dsw-alias-interactive-bg-hover)}
@media (hover:hover){.dsh-advisors-row:has(.dsh-advisors-switch:not(:disabled)):hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dsh-advisors-tip{position:absolute;z-index:50;left:0;top:calc(100% + 6px);max-width:300px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 24px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:normal}

/* ---- 设置页 ---- */
.dsh-advisors-page{display:flex;flex-direction:column;gap:20px;padding:4px 0 8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-advisors-page h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
.dsh-advisors-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;max-width:64ch}
.dsh-advisors-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:10px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-l1))}
.dsh-advisors-cardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dsh-advisors-cardTitle{font-weight:600}
.dsh-advisors-cardHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:64ch}
.dsh-advisors-field{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,220px);align-items:center;gap:12px 16px;padding:8px 0;border-top:1px solid var(--dsw-alias-separator-primary,var(--dsw-alias-border-l1))}
.dsh-advisors-field:first-of-type{border-top:none}
.dsh-advisors-fieldName{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-advisors-fieldTitle{font-weight:500}
.dsh-advisors-fieldSub{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dsh-advisors-status{font-size:11px;color:var(--dsw-alias-label-secondary);min-height:16px}
.dsh-advisors-error{color:var(--dsw-alias-state-error-primary)}
.dsh-advisors-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-advisors-retry{padding:2px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}

/* ---- 自绘下拉 ----
 * 不能用原生 <select>：Windows 上它的选项弹层是操作系统控件，不读页面 CSS，
 * 只会按系统的浅色主题画 —— 深色主题下就变成白底白字，选项完全看不见。
 * 这里用 button + 绝对定位面板自己画，颜色全部走主题 token。
 *
 * 面板是「搜索框 + 滚动列表」两段式：真实规模 40+ 模型 / 十几条通道，
 * 没有搜索框只能靠方向键逐屏扫。 */
.dsh-advisors-picker{position:relative;width:100%;min-width:0}
.dsh-advisors-trigger{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsh-advisors-trigger:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.dsh-advisors-trigger:disabled{opacity:.6;cursor:default}
.dsh-advisors-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-advisors-triggerText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-advisors-caret{flex:none;width:8px;height:8px;border-right:1.5px solid var(--dsw-alias-label-secondary);border-bottom:1.5px solid var(--dsw-alias-label-secondary);transform:translateY(-2px) rotate(45deg);transition:transform .15s ease}
.dsh-advisors-trigger[aria-expanded="true"] .dsh-advisors-caret{transform:translateY(2px) rotate(-135deg)}
.dsh-advisors-menu{position:absolute;z-index:40;top:calc(100% + 4px);right:0;left:0;display:flex;flex-direction:column;max-height:300px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-layer-1));box-shadow:0 8px 24px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);overflow:hidden}
.dsh-advisors-search{flex:none;box-sizing:border-box;width:100%;padding:7px 10px;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dsh-advisors-search::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dsh-advisors-search:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10))}
.dsh-advisors-list{flex:1 1 auto;min-height:0;max-height:260px;overflow-y:auto;padding:4px}
.dsh-advisors-nomatch{padding:8px 10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px}
.dsh-advisors-group{padding:6px 8px 2px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10px;letter-spacing:.04em;text-transform:uppercase}
/* 选项是 div 而不是 button：焦点统一由搜索框的 aria-activedescendant 管理，
 * 不能让它变成 Tab 序列里的 40 个停靠点。 */
.dsh-advisors-option{display:flex;flex-direction:column;gap:1px;width:100%;box-sizing:border-box;padding:5px 8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsh-advisors-option[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsh-advisors-option[aria-selected="true"] .dsh-advisors-optionName{color:var(--dsw-alias-brand-primary)}
.dsh-advisors-optionRow{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsh-advisors-optionName{flex:none;font-weight:500}
.dsh-advisors-optionId{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-family:var(--ds-font-family-code,monospace);font-size:10px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-advisors-optionNote{padding-left:20px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10.5px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-advisors-check{flex:none;width:12px;color:var(--dsw-alias-brand-primary);font-size:11px}
@media (max-width:560px){.dsh-advisors-field{grid-template-columns:minmax(0,1fr)}}
`

    function installStyle() {
      const el = document.createElement('style')
      el.setAttribute('data-dsh-advisors', '')
      el.textContent = CSS
      document.head.appendChild(el)
      return el
    }

    /** 统一读取：GET 一次拿开关 + 默认 + 目录 + 领域当前值。 */
    async function fetchState(sessionId) {
      const query = sessionId === undefined ? '' : '?sessionId=' + encodeURIComponent(sessionId)
      const res = await fetch(absAppPath(API + query))
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error((body && body.error) || '读取失败')
      return body
    }

    /**
     * 轻量读取：只要开关状态，**不触发目录枚举**。
     *
     * 模型菜单里那一行开关只需要一个布尔值。旧版让它走完整 GET，等于每次打开
     * 菜单都要枚举十几条通道——设置页的目录需求不该拖累这个小开关。
     */
    async function fetchSwitchState(sessionId) {
      const query = '?view=state' + (sessionId === undefined ? '' : '&sessionId=' + encodeURIComponent(sessionId))
      const res = await fetch(absAppPath(API + query))
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error((body && body.error) || '读取失败')
      return body
    }

    /** 统一写入：POST 一个 patch。 */
    async function postState(patch) {
      const res = await fetch(absAppPath(API), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error((body && body.error) || '保存失败')
      return body
    }

    /** 开关行。 */
    function AdvisorToggle(props) {
      const { sessionId, t } = props
      const [enabled, setEnabled] = React.useState(null)
      const [pending, setPending] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [tipOpen, setTipOpen] = React.useState(false)

      React.useEffect(() => {
        let live = true
        setFailure('')
        fetchSwitchState(sessionId).then((body) => {
          if (live) setEnabled(body.enabled === true)
        }, (error) => {
          if (live) setFailure(error && error.message ? error.message : String(error))
        })
        return () => { live = false }
      }, [sessionId])

      const toggle = () => {
        if (enabled === null || pending) return
        const next = !enabled
        setPending(true)
        setFailure('')
        postState({ sessionId, enabled: next }).then((body) => { setEnabled(body.enabled === true) }, (error) => {
          setFailure(t('mode.failed', { message: error && error.message ? error.message : String(error) }))
        }).finally(() => { setPending(false) })
      }

      /**
       * 行内只放名称；状态与说明都进 ⓘ 气泡。
       * 与「启用智能体团队协作」同构 —— 长句进标题行会把名称挤成一字一行。
       */
      const tipText = failure !== ''
        ? failure
        : enabled === null
          ? t('mode.loading')
          : `${t('mode.description')}\n\n${t('mode.approx')}`

      return h('div', { className: 'dsh-advisors-row' }, [
        h('span', { key: 'label', className: 'dsh-advisors-label' }, [
          h('span', { key: 'name', className: 'dsh-advisors-name' }, t('mode.label')),
          h('button', {
            key: 'info',
            type: 'button',
            className: 'dsh-advisors-info',
            'aria-label': t('mode.infoLabel'),
            'aria-expanded': tipOpen ? 'true' : 'false',
            title: tipText,
            onClick: (event) => {
              event.preventDefault()
              setTipOpen((open) => !open)
            },
            onMouseEnter: () => setTipOpen(true),
            onMouseLeave: () => setTipOpen(false),
          }, 'ⓘ'),
        ]),
        h('button', {
          key: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': enabled === true ? 'true' : 'false',
          'aria-label': t('mode.label'),
          title: t('mode.label'),
          className: 'dsh-advisors-switch',
          disabled: enabled === null || pending,
          onClick: toggle,
        }, h('span', {
          key: 'thumb',
          className: 'dsh-advisors-switch-thumb',
          'aria-hidden': 'true',
        })),
        tipOpen
          ? h('div', { key: 'tip', className: 'dsh-advisors-tip', role: 'tooltip' }, tipText)
          : null,
      ])
    }

    /** 子智能体会话（含顾问自己）不显示这个开关。 */
    function AdvisorToggleEntry(props) {
      const useSession = props.useSession
      const useSessions = props.useSessions
      const addressedChild = useSession ? useSession((snapshot) => snapshot.subagent !== null) : false
      const listedChild = useSessions
        ? useSessions((state) => state.byId[props.sessionId]?.origin === 'subagent')
        : false
      if (addressedChild || listedChild) return null
      return h(AdvisorToggle, props)
    }

    /**
     * 自绘下拉实例序号 + 模块命名空间。
     *
     * 每个 ModelPicker 拿一个唯一 id 前缀，供 aria-controls / aria-activedescendant
     * 使用（四个领域行必须互不串）。
     *
     * 命名空间用模块初始化时生成的随机串：万一宿主在同一页面里把 bundle
     * 初始化了两次（旧组件还没卸载、新组件已经挂载），两个模块各自从 1 开始
     * 计数就会撞 id，加了命名空间就不可能撞。
     */
    const PICKER_NAMESPACE = Math.random().toString(36).slice(2, 8)
    let pickerSeq = 0

    /**
     * 自绘下拉。原生 `<select>` 在 Windows 上的选项弹层不读页面 CSS，
     * 深色主题下会变成白底白字（实测），所以这里用 button + 面板自己画。
     *
     * 真实规模是 40+ 个模型、十几条通道，所以面板顶部有搜索框：
     * 只靠方向键逐屏扫几十项不可用。搜索匹配 模型名 / 完整 id / 通道名 / 通道 id。
     *
     * 键盘走**一套**完整模式，不混搭「button 各自聚焦 + 视觉 active」：
     *   触发器 Enter / Space / ↓ 展开 → 焦点进搜索框
     *   ↑↓ 移动高亮（aria-activedescendant 指向它）
     *   Enter 选中，Esc 关闭回触发器，Tab 正常离开并关闭
     *   搜索框里的空格必须是空格，不能沿用「Space 选中」
     */
    function ModelPicker(props) {
      const { label, groups, selected, effective, disabled, onPick, t } = props
      const [open, setOpen] = React.useState(false)
      const [activeKey, setActiveKey] = React.useState('default')
      const [query, setQuery] = React.useState('')
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const listRef = React.useRef(null)
      const searchRef = React.useRef(null)
      /** 输入法组合中：composition 事件维护，keydown 时读。 */
      const composingRef = React.useRef(false)
      // 每个实例自己的 DOM id 前缀，避免四个领域行的 aria 引用互相串。
      // 不能从 label 派生：label 是中文（「前端实现 / 组件与状态」），
      // 用 \W+ 清理会把中文全删掉，四个领域都退化成同一个前缀，aria 引用就串了。
      // 用模块级递增序号 —— 稳定、唯一、不依赖宿主 React 版本（useId 不一定有）。
      const idPrefixRef = React.useRef(null)
      if (idPrefixRef.current === null) {
        pickerSeq += 1
        idPrefixRef.current = `dsh-advisors-picker-${PICKER_NAMESPACE}-${pickerSeq}`
      }
      const idPrefix = idPrefixRef.current

      // 展开时点外面关闭。用捕获阶段，避免被宿主面板的 stopPropagation 吞掉。
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const root = rootRef.current
          if (root !== null && !root.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => { document.removeEventListener('mousedown', onDown, true) }
      }, [open])

      // 展开后把焦点交给搜索框：键盘用户不必先 Tab 过几十个选项。
      // preventScroll 避免聚焦动作把宿主的设置页滚一下。
      React.useEffect(() => {
        if (!open) return
        const box = searchRef.current
        if (box === null || typeof box.focus !== 'function') return
        try { box.focus({ preventScroll: true }) } catch { box.focus() }
      }, [open])

      const keyOf = (id) => (id === '' ? 'default' : `model:${id}`)

      /**
       * 两份列表，用途不同，不能混：
       *   allOptions  —— 完整目录，用于**显示已保存的选择**和决定打开时的高亮起点；
       *   visible     —— 过滤后的结果，用于渲染、导航、提交。
       *
       * 混用会出两个 bug（顾问复检指出）：
       *   1. 搜索把当前选中项过滤掉时，触发器文字会错成「跟随默认」；
       *   2. 打开时用过滤后的列表判断 selected，可能选错初始高亮。
       */
      /**
       * 唯一的匹配谓词。可见列表、活动项可见性、首个匹配**必须**共用它，
       * 否则会出现「列表里有匹配项、高亮却落到跟随默认」——
       * 那种情况下按 Enter 会把显式配置清成「跟随默认」。
       */
      const matches = (item, group, term) => term === '' || (
        `${item.label} ${item.id} ${item.note || ''} ${group.title} ${item.provider || ''}`
          .toLowerCase().includes(term)
      )

      const allOptions = [keyOf(''), ...groups.flatMap((group) => group.items.map((item) => keyOf(item.id)))]

      const q = query.trim().toLowerCase()
      const defaultItem = { id: '', label: t('page.followDefaultShort'), note: t('page.followDefaultNote', { model: effective }), key: 'default' }
      const visibleGroups = []
      for (const group of groups) {
        const kept = group.items.filter((item) => matches(item, group, q))
        if (kept.length > 0) visibleGroups.push({ key: group.key, title: group.title, items: kept })
      }
      const flat = [defaultItem]
      for (const group of visibleGroups) {
        // 分组标题的 React key 用**身份**，不是标题 —— 标题重名不该产生重复 key。
        flat.push({ groupKey: group.key, group: group.title })
        for (const item of group.items) {
          flat.push({ id: item.id, label: item.label, note: item.note || '', key: keyOf(item.id) })
        }
      }
      const selectable = flat.filter((item) => item.group === undefined)
      /**
       * resolvedActiveKey：经过可见性校验后的活动项。
       * ARIA、视觉高亮、Enter 提交、滚动**全部**用它 —— 三者必须永远指向同一项。
       * 之前 `activeIndex` 找不到时回落 0、而 `data-active` 仍比较原始 activeKey，
       * 会出现「ARIA 指向默认项、视觉上没有任何高亮」。
       */
      const foundIndex = selectable.findIndex((item) => item.key === activeKey)
      const activeIndex = foundIndex >= 0 ? foundIndex : 0
      const activeItem = selectable[activeIndex]
      const resolvedActiveKey = activeItem === undefined ? 'default' : activeItem.key

      // 高亮项滚进可视区。只调整列表自己的 scrollTop，不用 scrollIntoView
      // （它会连带滚动整个设置页）。
      // 坐标系必须一致：用 getBoundingClientRect 比较选项与列表的矩形，
      // 不能拿 row.offsetTop 和 list.scrollTop 比 —— offset parent 是绝对定位的
      // 面板（含搜索框高度），和列表的滚动坐标系不是同一个。
      React.useEffect(() => {
        const list = listRef.current
        if (!open || list === null || typeof list.querySelectorAll !== 'function') return
        const rows = list.querySelectorAll('[role="option"]')
        const row = rows[activeIndex]
        if (row === undefined || typeof row.getBoundingClientRect !== 'function') return
        const rowRect = row.getBoundingClientRect()
        const listRect = list.getBoundingClientRect()
        if (rowRect.top < listRect.top) {
          list.scrollTop -= listRect.top - rowRect.top
        } else if (rowRect.bottom > listRect.bottom) {
          list.scrollTop += rowRect.bottom - listRect.bottom
        }
        // 依赖里带上 query 与分组规模：过滤后即使索引没变，
        // 前面的分组标题和选项高度也可能已经变了。
      }, [open, activeIndex, query, selectable.length])

      const openMenu = () => {
        if (disabled) return
        setQuery('')
        // 从当前选中项开始高亮。用 allOptions（完整目录）判断，
        // 不能用上一次渲染的过滤结果 —— 那可能是空的或残缺的。
        const wanted = keyOf(selected ?? '')
        setActiveKey(allOptions.includes(wanted) ? wanted : 'default')
        setOpen(true)
      }

      const closeMenu = (returnFocus) => {
        setOpen(false)
        setQuery('')
        if (returnFocus) {
          const trigger = triggerRef.current
          if (trigger !== null && typeof trigger.focus === 'function') trigger.focus()
        }
      }

      const choose = (id) => {
        closeMenu(true)
        onPick(id === '' ? null : id)
      }

      const move = (delta) => {
        const next = Math.min(selectable.length - 1, Math.max(0, activeIndex + delta))
        const target = selectable[next]
        if (target !== undefined) setActiveKey(target.key)
      }

      /** 触发器上的键：只负责展开。 */
      const onTriggerKeyDown = (event) => {
        if (open) return
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
          event.preventDefault()
          openMenu()
        }
      }

      /**
       * 搜索框上的键：导航 + 提交。输入法组合期间绝不抢 Enter。
       *
       * React 的 onKeyDown 收到的是 SyntheticEvent，不能假定它带顶层
       * `isComposing`；原生事件在 nativeEvent 上，另外用 composition 事件
       * 维护一个 ref 兜底（部分浏览器组合结束的 Enter 不再带该标记）。
       */
      const onSearchKeyDown = (event) => {
        const composing = composingRef.current === true
          || event.isComposing === true
          || (event.nativeEvent !== undefined && event.nativeEvent !== null && event.nativeEvent.isComposing === true)
          || event.keyCode === 229
        if (composing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          closeMenu(true)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (activeItem !== undefined) choose(activeItem.id)
        }
        // 空格不处理：搜索框里空格就是空格。
        // Tab 也不处理：在 keydown 里同步卸载仍持有焦点的 input 会让浏览器
        // 丢失导航起点。改由根节点的 onBlur 判断焦点是否真的离开。
      }

      // 触发器文字必须来自**完整目录**，不是过滤结果：
      // 否则搜索把当前选中项过滤掉时，触发器会错显成「跟随默认」。
      const current = selectable.find((item) => item.key === keyOf(selected ?? ''))
        ?? (() => {
          // 过滤结果里没有当前选择时，从完整目录里找它的展示信息。
          if (selected === null || selected === undefined || selected === '') return selectable[0]
          for (const group of groups) {
            const hit = group.items.find((item) => item.id === selected)
            if (hit !== undefined) return { id: hit.id, label: hit.label, note: hit.note || '' }
          }
          return { id: selected, label: selected, note: '' }
        })()
      const triggerText = current.id === ''
        ? t('page.followDefault', { model: effective })
        : `${current.label} — ${current.id}`

      return h('div', {
        className: 'dsh-advisors-picker',
        ref: rootRef,
        // 焦点真正离开整个控件时才关闭（含 Tab / Shift+Tab）。
        // 不在 Tab 的 keydown 里卸载输入框：那会让浏览器丢失导航起点。
        onBlur: (event) => {
          const root = rootRef.current
          const next = event.relatedTarget
          if (root !== null && next !== null && next !== undefined && root.contains(next)) return
          closeMenu(false)
        },
      }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'dsh-advisors-trigger',
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': label,
          'aria-controls': `${idPrefix}-list`,
          disabled,
          onClick: () => { if (open) closeMenu(false); else openMenu() },
          onKeyDown: onTriggerKeyDown,
        }, [
          h('span', { key: 'text', className: 'dsh-advisors-triggerText' }, triggerText),
          h('span', { key: 'caret', className: 'dsh-advisors-caret', 'aria-hidden': 'true' }),
        ]),
        open
          ? h('div', { key: 'menu', className: 'dsh-advisors-menu' }, [
            h('input', {
              key: 'search',
              ref: searchRef,
              type: 'text',
              className: 'dsh-advisors-search',
              role: 'combobox',
              'aria-expanded': 'true',
              'aria-controls': `${idPrefix}-list`,
              'aria-autocomplete': 'list',
              'aria-activedescendant': activeItem === undefined ? undefined : `${idPrefix}-${activeItem.key}`,
              // 触发器和 listbox 的名称不会自动成为这个 combobox 的名称，
              // 必须显式给：读屏软件进到这个输入框时要能说出「在搜什么」。
              'aria-label': t('page.searchLabel', { domain: label }),
              placeholder: t('page.searchPlaceholder'),
              value: query,
              onChange: (event) => {
                const next = event.target.value
                setQuery(next)
                /**
                 * 搜索后的高亮规则（顾问复检指出「一律跳回默认项」会误操作：
                 * 搜到唯一模型后按 Enter 反而清掉显式选择）：
                 *   1. 当前活动项仍可见 → 保留；
                 *   2. 不可见 → 移到首个匹配的模型；
                 *   3. 没有匹配 → 退到默认项。
                 */
                const term = next.trim().toLowerCase()
                /**
                 * 当前活动项是否仍是合适的落点。
                 *
                 * 默认项**始终可见**，但「可见」不等于「该占着高亮」：
                 * 之前写成 `activeKey === 'default' || ...` 直接短路，结果按通道名
                 * 搜索时高亮一直赖在默认项上，Enter 就把显式配置清成了跟随默认。
                 * 所以默认项只在 term 为空（还没搜）时保留。
                 */
                const stillVisible = term === '' || (activeKey !== 'default'
                  && groups.some((group) => group.items.some((item) => (
                    `model:${item.id}` === activeKey && matches(item, group, term)
                  ))))
                if (stillVisible) return
                // 首个匹配：保留 group 上下文，不要先 flatMap 把通道标题丢掉。
                let firstMatch
                for (const group of groups) {
                  const hit = group.items.find((item) => matches(item, group, term))
                  if (hit !== undefined) { firstMatch = hit; break }
                }
                setActiveKey(firstMatch === undefined ? 'default' : `model:${firstMatch.id}`)
              },
              onKeyDown: onSearchKeyDown,
              onCompositionStart: () => { composingRef.current = true },
              onCompositionEnd: () => { composingRef.current = false },
            }),
            h('div', {
              key: 'list',
              ref: listRef,
              id: `${idPrefix}-list`,
              className: 'dsh-advisors-list',
              role: 'listbox',
              'aria-label': label,
            }, [
              ...(q === '' ? [] : visibleGroups.length === 0
                ? [h('div', { key: 'nomatch', className: 'dsh-advisors-nomatch', role: 'status' }, t('page.noMatch'))]
                : []),
              ...flat.map((item) => {
                if (item.group !== undefined) {
                  return h('div', {
                    // 用身份 key，不是标题：标题重名不该产生重复 React key。
                    key: `g:${item.groupKey}`,
                    className: 'dsh-advisors-group',
                    role: 'presentation',
                  }, item.group)
                }
                const isSelected = item.id === (selected ?? '')
                // 视觉高亮必须用 resolvedActiveKey（经过可见性校验的那个），
                // 否则原始 activeKey 不可见时，ARIA 指向默认项、视觉却一个都不亮。
                const isActive = item.key === resolvedActiveKey
                return h('div', {
                  key: `o:${item.key}`,
                  id: `${idPrefix}-${item.key}`,
                  role: 'option',
                  className: 'dsh-advisors-option',
                  'aria-selected': isSelected ? 'true' : 'false',
                  'data-active': isActive ? 'true' : undefined,
                  onMouseEnter: () => { setActiveKey(item.key) },
                  /**
                   * 关键时序：选项是 div（不可聚焦），鼠标按下会让搜索框失焦，
                   * 根节点 onBlur 拿到 relatedTarget=null 就立刻关掉面板，
                   * 随后的 click 就永远不发生了 —— 表现为「点一下只关面板、不选中」。
                   * 在 mousedown 上 preventDefault 阻止焦点转移，选择仍留给 click。
                   * 只拦主键，避免影响触摸滚动与右键。
                   */
                  onMouseDown: (event) => {
                    if (event.button === 0 || event.button === undefined) event.preventDefault()
                  },
                  onClick: () => { choose(item.id) },
                }, [
                  h('span', { key: 'row', className: 'dsh-advisors-optionRow' }, [
                    h('span', { key: 'check', className: 'dsh-advisors-check' }, isSelected ? '✓' : ''),
                    h('span', { key: 'name', className: 'dsh-advisors-optionName' }, item.label),
                    // 模型 id 写出来：这是「这个领域到底跑哪个模型」的唯一精确答案。
                    h('span', { key: 'id', className: 'dsh-advisors-optionId' },
                      item.id === '' ? effective : item.id),
                  ]),
                  // note 是「为什么该选它」的理由，挑模型时比 id 更有用，别丢。
                  item.note === ''
                    ? null
                    : h('span', { key: 'note', className: 'dsh-advisors-optionNote' }, item.note),
                ])
              }),
            ]),
          ])
          : null,
      ])
    }

    /** 设置页里的一个领域行：名称 + 生效值 + 下拉。 */
    function DomainRow(props) {
      const { entry, catalog, disabled, onPick, t } = props
      const ids = new Set(catalog.map((m) => m.id))
      /**
       * 分组身份用 **provider id**，标题只负责显示 —— 两者从头到尾都不能混。
       *
       * 两轮都被这里坑过：
       *   1. 一开始拿 displayName 当 Map 的 key：同名通道会合并，且通道若叫
       *      「目录外」，特殊分组会直接覆盖掉它的模型。
       *   2. 改成先按 provider id 归组、再 `ordered.set(title, ...)` —— 又退回去了：
       *      a/b 都叫 chatgpt、c 叫 chatgpt（a）时，消歧后的标题会再次碰撞。
       *
       * 所以最终产物是**数组**，每项带独立 `key`（分组身份）与 `title`（显示）。
       * 标题再怎么重名，也只影响显示，不会丢模型。
       */
      const byProvider = new Map()
      for (const item of catalog) {
        const key = typeof item.provider === 'string' && item.provider !== '' ? item.provider : 'unknown'
        if (!byProvider.has(key)) {
          const raw = typeof item.providerName === 'string' ? item.providerName.trim() : ''
          byProvider.set(key, { key: `provider:${key}`, title: raw === '' ? key : raw, items: [] })
        }
        byProvider.get(key).items.push(item)
      }
      const groupList = [...byProvider.values()]
      // 同名通道加 id 后缀，让用户能分清两个「chatgpt」。只改标题，不改身份。
      const titleCount = new Map()
      for (const group of groupList) titleCount.set(group.title, (titleCount.get(group.title) ?? 0) + 1)
      for (const group of groupList) {
        if ((titleCount.get(group.title) ?? 0) > 1) {
          group.title = `${group.title}（${group.key.slice('provider:'.length)}）`
        }
      }
      if (entry.selected !== null && !ids.has(entry.selected)) {
        // 特殊分组用独立 key，标题即使和某个真实通道重名也不会覆盖它。
        groupList.push({
          key: 'special:outside',
          title: t('page.outsideCatalog'),
          items: [{
            id: entry.selected,
            label: entry.selected,
            note: t('page.outsideCatalogNote'),
          }],
        })
      }
      return h('div', { className: 'dsh-advisors-field' }, [
        h('div', { key: 'name', className: 'dsh-advisors-fieldName' }, [
          h('span', { key: 'title', className: 'dsh-advisors-fieldTitle' }, entry.label),
          h('span', { key: 'sub', className: 'dsh-advisors-fieldSub' },
            `${t('page.effectivePrefix')}：${entry.effective}`),
        ]),
        h(ModelPicker, {
          key: 'picker',
          label: entry.label,
          // 数组，每项 { key, title, items } —— 不是 Map<标题, 数组>。
          groups: groupList,
          selected: entry.selected,
          effective: entry.effective,
          disabled,
          onPick: (modelId) => { onPick(entry.domain, modelId) },
          t,
        }),
      ])
    }

    /** 设置页。数据全部来自 /dsh-advisors-api，改一项立刻回写。 */
    function AdvisorSettingsPage(props) {
      const { t } = props
      const [view, setView] = React.useState(null)
      const [failure, setFailure] = React.useState('')
      const [pending, setPending] = React.useState(false)
      const [saved, setSaved] = React.useState(false)

      const load = React.useCallback(() => {
        let live = true
        setFailure('')
        fetchState().then((body) => { if (live) setView(body) }, (error) => {
          if (live) setFailure(error && error.message ? error.message : String(error))
        })
        return () => { live = false }
      }, [])

      React.useEffect(load, [])

      /** 乐观更新：先改本地，失败再回滚并报错。 */
      const commit = (patch, apply) => {
        if (pending) return
        const before = view
        setView(apply(view))
        setPending(true)
        setSaved(false)
        setFailure('')
        postState(patch).then((body) => {
          if (body.catalog && body.domains) setView(body)
          setSaved(true)
        }, (error) => {
          setView(before)
          setFailure(t('page.saveFailed', { message: error && error.message ? error.message : String(error) }))
        }).finally(() => { setPending(false) })
      }

      const pick = (domain, modelId) => {
        commit({ domain, modelId }, (current) => (current === null ? current : {
          ...current,
          domains: current.domains.map((entry) => (entry.domain === domain
            ? { ...entry, selected: modelId, effective: modelId === null ? entry.effective : modelId }
            : entry)),
        }))
      }

      const setDefault = (enabled) => {
        commit({ defaultEnabled: enabled }, (current) => (current === null ? current : {
          ...current,
          defaultEnabled: enabled,
        }))
      }

      if (failure !== '' && view === null) {
        return h('div', { className: 'dsh-advisors-page' }, [
          h('div', { key: 'banner', className: 'dsh-advisors-banner' }, [
            h('span', { key: 'text', className: 'dsh-advisors-error' },
              t('page.failed', { message: failure })),
            h('button', { key: 'retry', type: 'button', className: 'dsh-advisors-retry', onClick: load },
              t('page.retry')),
          ]),
        ])
      }
      if (view === null) {
        return h('div', { className: 'dsh-advisors-page' }, [
          h('p', { key: 'loading', className: 'dsh-advisors-intro' }, t('page.loading')),
        ])
      }

      const status = failure !== '' ? failure : saved ? t('page.saved') : ''

      return h('div', { className: 'dsh-advisors-page' }, [
        h('h2', { key: 'title' }, t('page.title')),
        h('p', { key: 'intro', className: 'dsh-advisors-intro' }, t('page.intro')),

        h('section', { key: 'default', className: 'dsh-advisors-card' }, [
          h('div', { key: 'head', className: 'dsh-advisors-cardHead' }, [
            h('div', { key: 'copy' }, [
              h('div', { key: 'title', className: 'dsh-advisors-cardTitle' }, t('page.defaultLabel')),
              h('p', { key: 'hint', className: 'dsh-advisors-cardHint' }, t('page.defaultHint')),
            ]),
            h('button', {
              key: 'switch',
              type: 'button',
              role: 'switch',
              'aria-checked': view.defaultEnabled === true ? 'true' : 'false',
              'aria-label': t('page.defaultLabel'),
              className: 'dsh-advisors-switch',
              disabled: pending,
              onClick: () => { setDefault(view.defaultEnabled !== true) },
            }),
          ]),
        ]),

        h('section', { key: 'domains', className: 'dsh-advisors-card' }, [
          h('div', { key: 'head', className: 'dsh-advisors-cardHead' }, [
            h('div', { key: 'copy' }, [
              h('div', { key: 'title', className: 'dsh-advisors-cardTitle' }, t('page.domainHeader')),
              h('p', { key: 'hint', className: 'dsh-advisors-cardHint' }, t('page.domainHint')),
            ]),
          ]),
          ...view.domains.map((entry) => h(DomainRow, {
            key: entry.domain,
            entry,
            catalog: view.catalog ?? [],
            disabled: pending,
            onPick: pick,
            t,
          })),
          h('p', { key: 'catalogHint', className: 'dsh-advisors-cardHint' }, t('page.writableHint')),
        ]),

        h('p', {
          key: 'status',
          className: failure === '' ? 'dsh-advisors-status' : 'dsh-advisors-status dsh-advisors-error',
          role: failure === '' ? 'status' : 'alert',
        }, status),
      ])
    }

    function apply(ctx) {
      const styleEl = installStyle()
      ctx.effect(() => () => { styleEl.remove() }, 'dsh-advisors: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-advisors: dictionaries')

      // 1) 模型菜单里的会话开关。
      ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
        name: 'conversation.input.model.options',
        id: 'dsh-advisors',
        order: 5,
        locale: NS,
      }, AdvisorToggleEntry))

      // 2) 设置页：四个领域的模型 + 新会话默认开启。
      const t = (key, values) => format(ctx.locale.bind(NS)(key), values)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 82,
        label: () => t('section.label'),
        locale: NS,
      }, AdvisorSettingsPage))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
