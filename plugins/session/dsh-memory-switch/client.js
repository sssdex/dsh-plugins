/**
 * dsh-memory-switch —— Client 半边。
 *
 * 在「模型 / 推理等级」那个菜单里加一行开关，紧挨着「启用智能体团队协作」与
 * 「启用只读顾问」（`conversation.input.model.options` 槽位）。
 *
 * 视觉必须与相邻那两行**逐像素同体例**：同一行高、同一字号、同一个 36×20 开关。
 * 因此这里不引宿主的 primitives（bundle 里 require 不到、且宿主版本会变），
 * 全部自己写，颜色只用 `--dsw-alias-*` 主题 token。
 *
 * 状态存在宿主侧（$DSH_HOME/dsh-memory-switch.json），通过本插件的
 * `/dsh-memory-switch-api` 同源路由读写 —— 与 dsh-advisors / dsh-meme 同款做法。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 从加载本 bundle 的 <script src> 反推子路径部署前缀（同 dsh-advisors）。 */
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

    const NS = 'dsh-memory-switch'
    const API = '/dsh-memory-switch-api'

    const zh = {
      'mode.label': '启用记忆上下文',
      // 说明走 ⓘ 气泡，不进标题行 —— 与「启用智能体团队协作」同构。
      'mode.description': '开启后，记忆系统会把「已有记忆摘要」「本轮相关记忆」「硬性规则」塞进本次会话的上下文。关闭只停注入：memory_save / memory_search / memory_get 这些工具照常可用，模型需要时会自己查。',
      'mode.infoLabel': '关于记忆上下文注入',
      'mode.loading': '读取开关…',
      'mode.failed': '无法保存开关，请重试：{message}',
      // 文案与插件行为保持同一口径：它是在注入**之后**摘掉，所以不承诺
      // 「打开就拿到摘要」—— 关着期间上游已经把摘要记成送过了，不会补发。
      'mode.on': '当前：已开启，本会话会注入记忆摘要与召回。',
      'mode.off': '当前：已关闭（默认）。开启后本会话开始注入记忆；关闭期间未送达的摘要不会补发。',
      'mode.notReady': '当前：已关闭，但拦截器没挂好 —— 记忆可能仍在注入。',
      'mode.notApplied': '偏好已保存，但总闸关着：要等总闸恢复后才生效。',
    }
    const en = {
      'mode.label': 'Memory context injection',
      'mode.description': 'When on, the memory system injects an existing-memory digest, per-turn recall, and hard rules into this session. Turning it off only stops injection: memory_save / memory_search / memory_get still work, so the model can look things up when it needs to. This is an output filter, so a digest that was generated while the switch was off will not be re-sent later.',
      'mode.infoLabel': 'About memory context injection',
      'mode.loading': 'Reading setting…',
      'mode.failed': 'Could not save. Try again: {message}',
      'mode.on': 'Now: on — this session injects memory digest and recall.',
      'mode.off': 'Now: off (default). Turning it on starts injection; digests missed while off are not re-sent.',
      'mode.notReady': 'Now: off, but the interceptor is not installed — memory may still be injected.',
      'mode.notApplied': 'Preference saved, but the master switch is off: it takes effect once that is turned back on.',
    }

    const format = (template, values) => String(template).replace(/\{(\w+)\}/g,
      (whole, key) => (values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole))

    /**
     * 样式**逐条对齐宿主的「启用智能体团队协作」那行**（agent-team 的
     * TeamModeToggle.module.css）。之前那版把长说明塞在行内，结果标签被挤成
     * 一字一行「启/用/记/忆/上/下/文」——因为它顶着 `min-width:0` 和一个
     * `white-space:nowrap` 的长句抢空间。
     *
     * 宿主的做法是：**行内只有名称 + 一个 ⓘ 图标**，说明文字全部走 Tooltip。
     * 这里照抄那个结构，一行不多：
     *   - row：min-height 34 / gap 16 / padding 0 8 / 13px / line-height 20
     *   - label：inline-flex / align-center / gap 4 / min-width 0
     *   - 名称本身**不允许换行**（nowrap），宁可省略也不竖排
     *   - 悬停高亮用 :has(:not(:disabled)) —— 只有能点时才亮
     */
    const CSS = `
.dsh-memory-switch-row{position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:34px;padding:0 8px;border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-memory-switch-label{display:inline-flex;align-items:center;gap:4px;min-width:0}
.dsh-memory-switch-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-memory-switch-info{position:relative;z-index:1;flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));cursor:pointer}
.dsh-memory-switch-info:hover{color:var(--dsw-alias-label-primary)}
.dsh-memory-switch-info:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-switch-switch{position:static;box-sizing:border-box;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
/* 开关撑满整行可点区域，和宿主那句 content:"" + inset:0 一致。 */
.dsh-memory-switch-switch:after{content:"";position:absolute;inset:0;border-radius:var(--dsw-radius-md,8px)}
.dsh-memory-switch-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsh-memory-switch-switch:disabled{cursor:default;opacity:.5}
.dsh-memory-switch-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-memory-switch-switch[aria-checked=false] .dsh-memory-switch-thumb{background:var(--dsw-alias-switch-thumb)}
.dsh-memory-switch-switch[aria-checked=true] .dsh-memory-switch-thumb{transform:translate(16px)}
.dsh-memory-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.dsh-memory-switch-row:has(.dsh-memory-switch-switch:focus-visible){background:var(--dsw-alias-interactive-bg-hover)}
@media (hover:hover){.dsh-memory-switch-row:has(.dsh-memory-switch-switch:not(:disabled)):hover{background:var(--dsw-alias-interactive-bg-hover)}}

/* 说明气泡：宿主 Tooltip 的轻量替代（portal 不到 body，就贴在图标旁）。 */
.dsh-memory-switch-tip{position:absolute;z-index:50;left:0;top:calc(100% + 6px);max-width:300px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 24px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:normal}
.dsh-memory-switch-tipAbove{top:auto;bottom:calc(100% + 6px)}
`

    function installStyle() {
      const el = document.createElement('style')
      el.setAttribute('data-dsh-memory-switch', '')
      el.textContent = CSS
      document.head.appendChild(el)
      return el
    }

    async function fetchState(sessionId) {
      const query = sessionId === undefined || sessionId === ''
        ? ''
        : '?sessionId=' + encodeURIComponent(sessionId)
      const res = await fetch(absAppPath(API + query))
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error((body && body.error) || '读取失败')
      return body
    }

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

    /** 开关行本体。 */
    function MemorySwitchToggle(props) {
      const { sessionId, t } = props
      const [enabled, setEnabled] = React.useState(null)
      const [ready, setReady] = React.useState(true)
      const [masterOff, setMasterOff] = React.useState(false)
      const [pending, setPending] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [tipOpen, setTipOpen] = React.useState(false)

      /**
       * 把一次服务端快照吸收进界面状态。
       *
       * `enabled` 是**有效值**（总闸 > 会话偏好 > 默认），`sessionOverride` 是
       * 用户自己的偏好。总闸关着时二者会不一致：偏好可能是 true，但有效值是
       * false —— 界面必须显示「偏好已保存，但总闸关着」，不能显示成已开启。
       */
      const absorb = (body) => {
        const effective = body.enabled === true
        const override = body.sessionOverride
        setEnabled(effective)
        setReady(body.ready !== false)
        setMasterOff(body.globalDisabled === true)
        if (!effective && override === true) setFailure(t('mode.notApplied'))
      }

      React.useEffect(() => {
        let live = true
        // 切换会话时清空回「加载中」：不清的话新会话会短暂显示上一个会话的状态。
        setEnabled(null)
        setPending(false)
        setFailure('')
        fetchState(sessionId).then((body) => {
          if (live) absorb(body)
        }, (error) => {
          if (live) setFailure(error && error.message ? error.message : String(error))
        })
        return () => { live = false }
      }, [sessionId])

      /**
       * 写入响应的代际校验：A 会话的慢响应绝不能覆盖 B 会话的界面。
       *
       * 注意这里**不再用代际去 gate `setPending(false)`**。第一版那样写过，
       * 结果是：在 A 点开关 → 请求还没回来就切到 B → effect 里 genRef 自增 →
       * A 的 `.finally` 因为代际不符被跳过 → `pending` 永远是 true → B 的按钮
       * 一直是禁用态，用户点不动了（而且看起来像「开关坏了」）。
       *
       * 现在组件按会话被 key 隔开（见 MemorySwitchEntry），切会话就是新实例，
       * 旧实例整个卸载，pending 天然不会串；这里的代际只用来丢弃过期的**数据**。
       */
      const genRef = React.useRef(0)
      React.useEffect(() => { genRef.current += 1 }, [sessionId])

      const toggle = () => {
        if (enabled === null || pending) return
        const next = !enabled
        const gen = genRef.current
        const forSession = sessionId
        setPending(true)
        setFailure('')
        // 乐观更新：开关立刻动，写失败再回滚。
        setEnabled(next)
        postState({ sessionId: forSession, enabled: next }).then((body) => {
          if (gen !== genRef.current) return
          if (!body) return
          // 用服务端的**有效状态**回填，而不是请求里的值：总闸关着时它是 false，
          // 界面才会如实显示「存了但没生效」。
          absorb(body)
        }, (error) => {
          if (gen !== genRef.current) return
          setEnabled(!next)
          setFailure(t('mode.failed', { message: error && error.message ? error.message : String(error) }))
        }).finally(() => {
          // 无条件复位：即便这次响应已经过期（切了会话），本实例自己的 pending
          // 也必须收掉，否则按钮会永久禁用。过期的数据前面已经丢弃，不会串台。
          setPending(false)
        })
      }

      /**
       * 行内**只放名称**。状态与说明都不进这一行 ——
       * 智能体团队那行就是这么做的：一旦把长句挤进来，名称会被压成一字一行
       * （截图里的「启/用/记/忆/上/下/文」就是这个原因）。
       *
       * 状态信息改由这几处承载：
       *   - 开关本身的 aria-checked（读屏）
       *   - ⓘ 气泡里的说明 + 当前状态
       *   - 出错时气泡里显示错误（不再是行内塞一长串红字）
       */
      const tipText = failure !== ''
        ? failure
        : enabled === null
          ? t('mode.loading')
          : enabled
            ? `${t('mode.description')}\n\n${t('mode.on')}`
            // 关着但拦截器没挂上：如实说明，别显示成一切正常。
            // 「已关闭」而记忆还在注入，是最坏的一种谎报。
            : ready
              ? `${t('mode.description')}\n\n${t('mode.off')}`
              : `${t('mode.description')}\n\n${t('mode.notReady')}`

      return h('div', { className: 'dsh-memory-switch-row' }, [
        h('span', { key: 'label', className: 'dsh-memory-switch-label' }, [
          h('span', { key: 'name', className: 'dsh-memory-switch-name' }, t('mode.label')),
          h('button', {
            key: 'info',
            type: 'button',
            className: 'dsh-memory-switch-info',
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
          className: 'dsh-memory-switch-switch',
          disabled: enabled === null || pending,
          onClick: toggle,
        }, h('span', {
          key: 'thumb',
          className: 'dsh-memory-switch-thumb',
          'aria-hidden': 'true',
        })),
        tipOpen
          ? h('div', { key: 'tip', className: 'dsh-memory-switch-tip', role: 'tooltip' }, tipText)
          : null,
      ])
    }

    /**
     * 子智能体会话里不显示这个开关（和相邻的两个开关同一条规则）。
     *
     * 另外**按 sessionId 给 Toggle 一个 key**：切会话时 React 会卸载旧实例、
     * 挂新实例，而不是复用同一个组件去换 props。不这样做的话，`pending` /
     * `enabled` 这些本地状态会跨会话残留，切换瞬间显示的可能是上一个会话的值，
     * 慢请求回来还可能把新会话的界面改掉。key 是最省事也最彻底的隔离方式。
     */
    function MemorySwitchEntry(props) {
      const useSession = props.useSession
      const useSessions = props.useSessions
      const addressedChild = typeof useSession === 'function'
        ? useSession((snapshot) => snapshot.subagent !== null)
        : false
      const listedChild = typeof useSessions === 'function'
        ? useSessions((state) => state.byId && state.byId[props.sessionId]?.origin === 'subagent')
        : false
      if (addressedChild || listedChild) return null
      return h(MemorySwitchToggle, { ...props, key: String(props.sessionId ?? '') })
    }

    function apply(ctx) {
      const styleEl = installStyle()
      ctx.effect(() => () => { styleEl.remove() }, 'dsh-memory-switch: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory-switch: dictionaries')

      // order 4：排在「启用智能体团队协作」之后、「启用只读顾问」(5) 之前，
      // 三个会话级开关连成一块。
      ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
        name: 'conversation.input.model.options',
        id: 'dsh-memory-switch',
        order: 4,
        locale: NS,
      }, MemorySwitchEntry))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
