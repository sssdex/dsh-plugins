/**
 * dsh-tavern-render —— DSH 客户端 bundle（浏览器侧）。
 *
 * 加载契约（务必保持）：
 *   window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名，
 *   factory 返回 { inject, apply }。宿主把多个插件的源码拼进同一个 <script>，
 *   所以整个 bundle 包一层 IIFE，避免顶层 const 泄漏到全局词法作用域。
 *
 * 浏览器里没有 import 相对路径的能力（不会被当成 ES 模块），所以解析器、
 * 渲染器、样式表由 build.mjs 内联进本文件。改那三个文件的源码后运行：
 *   node scripts/build.mjs
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么是「读 DOM 再另画一层」而不是「用 slot 自己渲染正文」
 * ═══════════════════════════════════════════════════════════════════════
 * 详见 docs/SLOT-RESEARCH.md。结论：
 *   · 助手正文由内部 AssistantMarkdown 渲染，宿主没暴露「替换正文渲染」的 slot；
 *   · 唯一能拿到渲染权的路是抢注 keyed slot `assistant-step`（priority: -1 可顶掉），
 *     但那要自己重写 reasoning 折叠 / 工具卡片 / 图片槽 / assistant-actions / 流式策略，
 *     而 AssistantMarkdown 没有对外导出，复用不了 —— 代价不可接受；
 *   · 正文纯文本其实拿得到（props.node.data.blocks），所以「只能读 DOM」不准确，
 *     准确说法是「有数据、没渲染权」。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 上一轮为什么出事故，这一轮怎么堵（四道闸）
 * ═══════════════════════════════════════════════════════════════════════
 * 坑 1：用 CSS Module 类名指纹（<hash>_root + <hash>_body）找正文容器。
 *       该命名在 DSH 里不唯一，至少 8 个组件共用，其中包含思考过程容器
 *       → 思考文本被当酒馆回话重排。
 * 坑 2：「有引号/星号就当正文」的宽松兜底 → 普通技术回复被误伤。
 * 坑 3：预设约束写成绝对律 → 模型在编程任务里把代码塞进 <scene>。
 *
 * 这一轮的闸（按执行顺序，任何一关不过就彻底不接管）：
 *   闸 1  预设白名单：会话的 agentPreset 不在白名单 → 什么都不做。
 *   闸 2  锚点：只在 [data-chat-flow-kind="assistant-step"] 内工作，
 *        排除 [data-chat-group-part="reasoning"] 与 [data-turn-process-inline] 子树。
 *        全部用宿主自己的业务语义属性，不用构建哈希类名。
 *   闸 3  唯一性：正文 markdown 容器必须恰好 1 个，且能确认落在 _root > _body 里；
 *        0 个或多个一律放弃。
 *   闸 4  严格解析：只接受 syntax === 'trs' 或 'legacy'，
 *        **明确拒绝 'loose'**（「有引号就当正文」的兜底已从根上不要）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 最关键的改动：不覆盖宿主 DOM，只加一层
 * ═══════════════════════════════════════════════════════════════════════
 * 上一轮用 `body.innerHTML = html` 改写宿主节点，原文另存字符串以便还原。
 * 这种写法有两个根本缺陷：破坏 React 管理的节点树；一旦保存/还原环节出错，
 * 用户的内容就真没了。
 *
 * 现在改成**纯叠加**：
 *   · 给 `_body` 打一个标记 data-tt-body="1"；
 *   · 把排版结果作为**新节点追加**到 `_body` 末尾（React 自己的子节点一个没碰）；
 *   · 用一段 CSS 把 `_body` 里「非本插件节点」的子元素 display:none。
 * 还原 = 删掉我们那个节点 + 去掉标记，宿主的 DOM 从头到尾没被改写过，
 * 所以**任何情况下都不可能吞内容**。
 */
(() => {
  window.__ModuleLoader__.load({
    id: 'dsh-tavern-render',
    factory(require) {
      /* ===================== 内联：parse.js ===================== */
      /* __INLINE_PARSE__ */

      /* ===================== 内联：render.js ==================== */
      /* __INLINE_RENDER__ */

      /* ===================== 内联：styles.js ==================== */
      /* __INLINE_STYLES__ */

      /* ===================== 客户端逻辑 ===================== */

      const PLUGIN = 'dsh-tavern-render';
      const LOG = `[${PLUGIN}]`;

      /** 我们把排版结果挂进 _body 后，用它认领自己的节点。 */
      const ATTR_BODY = 'data-tt-body';
      /** 已经处理过的 body（幂等标记）。 */
      const ATTR_DONE = 'data-tt-done';
      /** 单条消息的语法来源，便于排查。 */
      const ATTR_SYNTAX = 'data-tt-syntax';

      /** 默认配置。presets 是硬编码白名单，用户可在 profile 里覆盖。 */
      const DEFAULTS = Object.freeze({
        enabled: true,
        // 只在这个（些）预设里生效。不匹配 = 彻底不接管，从根上杜绝污染其他工作区。
        presets: ['tavern-play'],
        // 接管门槛：结构化正文至少要有一段对白或一个面板块，避免把一段散文重排。
        minSpeech: 1,
      });

      /* ─────────────────────────── 闸 1：预设白名单 ─────────────────────────── */

      /**
       * 从任意节点回溯到它所属的会话 id。
       * 证据：dsh-client-ui-conversation `data-conversation-session`（SLOT-RESEARCH §5.4）。
       * @param {Element|null} el
       * @returns {string|null}
       */
      function sessionIdOf(el) {
        if (!el || typeof el.closest !== 'function') return null;
        const host = el.closest('[data-conversation-session]');
        if (!host) return null;
        const id = host.getAttribute('data-conversation-session');
        return id || null;
      }

      /**
       * 读当前会话用的预设 id。
       *
       * 证据：dsh-client-ui-conversation:16156 `session.projections.faceOf('agentPreset').getSnapshot()`，
       * 类型是 string | undefined；且它出现在普通类（非 React）的构造函数里，说明不依赖 hook。
       *
       * ⚠️ 未在真机核对：返回值到底是预设的 `id`（'tavern-play'）还是 `name`（'酒馆·扮演'）。
       * 因此下面同时接受 id 与显示名——两种都对，宁可宽松也不能整个闸失效。
       * 真机验证命令见 README「排错」一节。
       *
       * @param {Element} el 该会话里的任意节点
       * @param {object} ctx 客户端根上下文
       * @returns {string|null}
       */
      function presetOf(el, ctx) {
        const sid = sessionIdOf(el);
        if (!sid) return null;
        const sessions = ctx && ctx.sessions;
        if (!sessions || typeof sessions.binding !== 'function') return null;
        let binding;
        try {
          binding = sessions.binding(sid);
        } catch {
          return null;
        }
        const session = binding && binding.session;
        const projections = session && session.projections;
        if (!projections || typeof projections.faceOf !== 'function') return null;
        try {
          const value = projections.faceOf('agentPreset').getSnapshot();
          return typeof value === 'string' ? value : null;
        } catch {
          return null;
        }
      }

      /**
       * 闸 1。不匹配就返回 false —— 调用方必须立刻收手，一个字节都不要改。
       * @param {Element} el
       * @param {object} cfg
       * @param {object} ctx
       * @returns {boolean}
       */
      function isTavernSession(el, cfg, ctx) {
        const allow = Array.isArray(cfg.presets) && cfg.presets.length > 0 ? cfg.presets : DEFAULTS.presets;
        const preset = presetOf(el, ctx);
        // 拿不到预设（无 sessions 服务、新建会话、读取异常）→ 一律当「不是酒馆会话」。
        // 这一条是整个插件安全性的基石：宁可什么都不做，也不能误伤。
        if (preset === null) return false;
        return allow.includes(preset);
      }

      /* ───────────────────── 闸 2 + 闸 3：找正文容器 ───────────────────── */

      /** CSS Module 类名形如 `xMeOpW_body`：只认后缀形式，不认具体哈希。 */
      const RE_BODY_CLASS = /(?:^|\s)[A-Za-z0-9_-]+_body(?:\s|$)/;
      const RE_ROOT_CLASS = /(?:^|\s)[A-Za-z0-9_-]+_root(?:\s|$)/;

      /**
       * 确认「正文 markdown 容器」确实是 AssistantMarkdown 的 `_body` 的直接子元素，
       * 且它的父链上认得出 `_root`。
       *
       * 层级（SLOT-RESEARCH §4.2，已核对）：
       *   div[data-chat-flow-kind="assistant-step"]
       *   └─ div[data-slot="conversation.chat.node"]   ← display:contents 的槽位锚点
       *      └─ div.<hash>_root
       *         └─ div.<hash>_body
       *            ├─ div.<hash>_markdown[data-text-interaction-source]   ← 正文
       *            └─ div[data-turn-process-inline] > div.<hash>_root     ← 思考行（要排除）
       *
       * @param {Element} src 候选正文 markdown 容器
       * @param {Element} flowItem assistant-step 的 flowItem
       * @returns {{body: Element, root: Element}|null}
       */
      function confirmBody(src, flowItem) {
        const body = src.parentElement;
        if (!body) return null;
        const cls = body.getAttribute('class') || '';
        if (!RE_BODY_CLASS.test(cls)) return null;

        const root = body.parentElement;
        if (!root) return null;
        const rootCls = root.getAttribute('class') || '';
        if (!RE_ROOT_CLASS.test(rootCls)) return null;

        // root 必须在 flowItem 之下，且与 flowItem 之间只隔着槽位锚点这一层。
        // 不满足就说明结构变了 —— 直接放弃，交给原生渲染。
        if (root === flowItem || !flowItem.contains(root)) return null;
        const between = root.parentElement;
        const plausible =
          between === flowItem ||
          (between !== null && between.hasAttribute('data-slot')) ||
          (between !== null && between.parentElement === flowItem);
        if (!plausible) return null;

        return { body, root };
      }

      /**
       * 在一个 assistant-step 的 flowItem 里找出唯一合法的正文容器。
       * 0 个或多个 → 返回 null（放弃）。
       * @param {Element} flowItem
       * @returns {{body: Element, root: Element}|null}
       */
      function findBodyIn(flowItem) {
        // 闸 2 补充：reasoning 分组不碰（取值域只有 "reasoning" | "response" | 缺失）。
        if (flowItem.getAttribute('data-chat-group-part') === 'reasoning') return null;

        // 候选：宿主自己给「已结束的正文」挂的语义标记。
        // 它只在 settled 且拿到 messageId 时才渲染，所以流式期间天然不命中。
        const all = flowItem.querySelectorAll('[data-text-interaction-source]');
        const hits = [];
        for (const node of all) {
          // 排除思考行（它也被挂了同一个属性）。
          if (node.closest('[data-turn-process-inline]') !== null) continue;
          hits.push(node);
        }
        // 闸 3：必须恰好一个。多个说明这条消息有分段的正文，我们不猜。
        if (hits.length !== 1) return null;

        const confirmed = confirmBody(hits[0], flowItem);
        if (!confirmed) return null;

        // 流式保护：AssistantMarkdown 的根在流式时带 data-streaming。
        if (confirmed.root.hasAttribute('data-streaming')) return null;
        if (confirmed.root.closest('[data-chat-running]') !== null) return null;

        return confirmed;
      }

      /* ───────────────────────── 闸 4：严格解析 ───────────────────────── */

      /**
       * 只接受有明确标签指纹的消息。
       *
       * 'trs'    —— <scene>/<panel>/<char> 规范语法
       * 'legacy' —— <mainbody>/<phone> 旧格式
       * 'loose'  —— ❌ 明确拒绝。「有引号/星号就当正文」正是上一轮误伤普通回复的原因，
       *             这次从根上不要，而不是靠 minSpeech 门槛去挡。
       * @param {{kind:string, syntax:string}} parsed
       * @returns {boolean}
       */
      function isAcceptable(parsed) {
        if (!parsed || parsed.kind !== 'structured') return false;
        return parsed.syntax === 'trs' || parsed.syntax === 'legacy';
      }

      /**
       * 接管门槛：结构化消息要有可看的东西。
       * 有面板块（状态/消息/动态/列表/选项）直接通过；只有正文时要求至少一段对白。
       * @param {object} parsed
       * @param {object} cfg
       * @returns {boolean}
       */
      function passesThreshold(parsed, cfg) {
        const minSpeech = Number(cfg.minSpeech ?? DEFAULTS.minSpeech);
        let speech = 0;
        for (const block of parsed.blocks) {
          if (block.type === 'prose') {
            for (const seg of block.segments) if (seg.kind === 'speech') speech += 1;
          } else if (block.type === 'chars' || block.type === 'status' || block.type === 'choices') {
            return true;
          } else if (block.type === 'social' && block.accounts.length > 0) {
            return true;
          } else if (block.type === 'wechat' && block.messages.length > 0) {
            return true;
          } else if (block.type === 'list' && block.items.length > 0) {
            return true;
          }
        }
        return speech >= minSpeech;
      }

      /* ─────────────────────────── 挂 / 卸 ─────────────────────────── */

      /** 只显示我们的节点，其余原生子节点一律隐藏（不删除）。 */
      const HIDE_CSS = `
[${ATTR_BODY}="1"] > :not([data-dsh-tavern-render]) {
  display: none !important;
}
`;

      /**
       * 把排版结果叠加到一条消息上。
       * 不写宿主的 innerHTML / textContent —— 只追加一个节点 + 打标记。
       * @param {{body: Element, root: Element}} found
       * @param {object} cfg
       * @param {object} ctx
       * @returns {'rendered'|'skipped'|'plain'}
       */
      function renderInto(found, cfg, ctx) {
        const { body } = found;
        if (!body || !body.isConnected) return 'skipped';
        if (body.getAttribute(ATTR_DONE) === '1') return 'rendered';

        // 闸 1：不是酒馆预设，立刻收手。
        if (!isTavernSession(body, cfg, ctx)) return 'skipped';

        const text = body.textContent || '';
        const parsed = parseMessage(text);
        // 闸 4
        if (!isAcceptable(parsed)) return 'plain';
        if (!passesThreshold(parsed, cfg)) return 'plain';

        const html = renderMessage(parsed);
        if (!html) return 'plain';

        const node = body.ownerDocument.createElement('div');
        node.innerHTML = html;
        const painted = node.firstElementChild;
        if (!painted) return 'plain';

        body.appendChild(painted);
        body.setAttribute(ATTR_BODY, '1');
        body.setAttribute(ATTR_DONE, '1');
        body.setAttribute(ATTR_SYNTAX, parsed.syntax || 'trs');
        return 'rendered';
      }

      /**
       * 还原一条消息：删掉我们的节点，摘掉标记。
       * 宿主的子节点从头到尾没被碰过，所以还原后就是原样。
       * @param {Element} body
       */
      function restoreBody(body) {
        if (!body) return;
        for (const node of body.querySelectorAll(':scope > [data-dsh-tavern-render]')) {
          node.remove();
        }
        body.removeAttribute(ATTR_BODY);
        body.removeAttribute(ATTR_DONE);
        body.removeAttribute(ATTR_SYNTAX);
      }

      /* ─────────────────────────── 选项点击发送 ─────────────────────────── */

      /**
       * 把点击翻译成一次真实的用户消息发送。
       *
       * 宿主入口（证据见 docs/SLOT-RESEARCH.md）：
       *   `send()` 在会话作用域的 BoundConversation 上，根服务只有 binding/imageUrl 等。
       *   官方报错文案直接写明了正确取法：
       *     "conversation.send requires a session scope — address one via ctx.sessions.scope(id).conversation"
       *   所以走 `ctx.sessions.scope(sessionId).get('conversation').send(text)`。
       *
       * 安全边界：
       *   · 仍然只在酒馆预设会话里生效（先过闸 1）；
       *   · 任何异常都只 catch 打日志，绝不影响渲染主流程；
       *   · 发送中/完成后给视觉反馈，避免重复点。
       *
       * @param {Element} el 被点的 .tt-choice
       * @param {object} cfg
       * @param {object} ctx
       * @returns {Promise<boolean>} 是否真的发出了
       */
      async function sendChoice(el, cfg, ctx) {
        const text = el.getAttribute('data-tt-send');
        if (!text) return false;
        // 闸 1：不是酒馆预设，不接管交互
        if (!isTavernSession(el, cfg, ctx)) return false;

        const sessionId = sessionIdOf(el);
        if (!sessionId) return false;

        const sessions = ctx && ctx.sessions;
        if (!sessions || typeof sessions.scope !== 'function') {
          console.warn(`${LOG} 无法发送选项：ctx.sessions.scope 不可用`);
          return false;
        }

        let conversation;
        try {
          const scope = sessions.scope(sessionId);
          conversation = scope && typeof scope.get === 'function' ? scope.get('conversation') : undefined;
        } catch (err) {
          console.warn(`${LOG} 取会话作用域失败：`, err);
          return false;
        }
        if (!conversation || typeof conversation.send !== 'function') {
          console.warn(`${LOG} 无法发送选项：会话作用域里没有 conversation.send`);
          return false;
        }

        // 视觉反馈：先锁定，避免连点发两条
        const section = el.closest('.tt-choices');
        const all = section ? Array.from(section.querySelectorAll('.tt-choice')) : [el];
        for (const node of all) {
          node.setAttribute('aria-disabled', 'true');
          node.classList.add('tt-choice-busy');
        }
        el.classList.add('tt-choice-sending');

        try {
          await conversation.send(text);
          el.classList.remove('tt-choice-sending');
          el.classList.add('tt-choice-sent');
          return true;
        } catch (err) {
          console.warn(`${LOG} 发送选项失败：`, err);
          for (const node of all) {
            node.removeAttribute('aria-disabled');
            node.classList.remove('tt-choice-busy');
          }
          el.classList.remove('tt-choice-sending');
          el.classList.add('tt-choice-failed');
          window.setTimeout(() => el.classList.remove('tt-choice-failed'), 1600);
          return false;
        }
      }

      /**
       * 在 document 上挂一个委托监听（只装一次），处理 .tt-choice 的点击/回车。
       * 用委托而不是给每个节点绑事件：我们的排版节点会被反复重建，委托不会漏。
       */
      function installChoiceHandler(cfg, ctx) {
        const onClick = (event) => {
          const target = event.target;
          if (!target || typeof target.closest !== 'function') return;
          const choice = target.closest('.tt-choice[data-tt-send]');
          if (!choice) return;
          // 已经发过/正在发，忽略
          if (choice.classList.contains('tt-choice-sent')
            || choice.classList.contains('tt-choice-sending')
            || choice.getAttribute('aria-disabled') === 'true') return;
          event.preventDefault();
          event.stopPropagation();
          void sendChoice(choice, cfg, ctx);
        };

        const onKey = (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const target = event.target;
          if (!target || typeof target.closest !== 'function') return;
          if (!target.closest('.tt-choice[data-tt-send]')) return;
          event.preventDefault();
          onClick(event);
        };

        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }

      /* ─────────────────────────── apply ─────────────────────────── */

      function apply(ctx, config) {
        const cfg = { ...DEFAULTS, ...(config || {}) };
        const doc = document;

        // 样式：只注入一次。选择器全部以 .tt-* / [data-tt-body] 为根，不外溢。
        let styleEl = doc.getElementById(STYLE_ID);
        if (styleEl === null) {
          styleEl = doc.createElement('style');
          styleEl.id = STYLE_ID;
          styleEl.dataset.plugin = PLUGIN;
          styleEl.textContent = buildCSS() + HIDE_CSS;
          doc.head.appendChild(styleEl);
        }

        let disposed = false;
        let timer = 0;
        /** 见过并可能被我们处理过的 body，用于卸载时还原。 */
        const touched = new Set();
        /** 作用域属性只在「确实渲染了东西」时才挂到 body 上。 */
        let scoped = false;

        const ensureScope = () => {
          if (scoped) return;
          doc.body.setAttribute(SCOPE_ATTR, '');
          scoped = true;
        };

        const releaseScope = () => {
          if (!scoped) return;
          doc.body.removeAttribute(SCOPE_ATTR);
          scoped = false;
        };

        const scan = () => {
          if (disposed) return;

          // 只扫会话内容容器，不扫整个 body。
          const hosts = doc.querySelectorAll('[data-conversation-session]');
          for (const host of hosts) {
            const flowItems = host.querySelectorAll('[data-chat-flow-kind="assistant-step"]');
            for (const flowItem of flowItems) {
              const found = findBodyIn(flowItem);
              if (!found) continue;

              touched.add(found.body);

              if (!cfg.enabled) {
                restoreBody(found.body);
                continue;
              }
              try {
                const outcome = renderInto(found, cfg, ctx);
                if (outcome === 'rendered') ensureScope();
              } catch (err) {
                // 单条消息出错只影响这一条：把残留摘干净，保留原生显示。
                console.warn(`${LOG} 渲染失败，保留原生显示：`, err);
                try { restoreBody(found.body); } catch { /* 已卸载 */ }
              }
            }
          }

          // 关掉开关后，把之前渲染过的也还原。
          if (!cfg.enabled) {
            for (const body of touched) restoreBody(body);
            touched.clear();
            releaseScope();
          }
        };

        const schedule = () => {
          if (disposed || timer) return;
          timer = window.setTimeout(() => {
            timer = 0;
            scan();
          }, 120);
        };

        /**
         * 只观察会话内容区。且忽略「我们自己追加节点」引起的变动（否则会自激）。
         */
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target;
            if (target && target.nodeType === 1 && target.closest
              && target.closest('[data-dsh-tavern-render]') !== null) {
              continue;
            }
            schedule();
            return;
          }
        });

        const observeHosts = () => {
          for (const host of doc.querySelectorAll('[data-conversation-session]')) {
            observer.observe(host, { childList: true, subtree: true });
          }
        };
        observeHosts();
        schedule();

        // 选项点击 → 真实发送。只装一次；卸载时摘掉。
        let removeChoiceHandler = null;
        try {
          removeChoiceHandler = installChoiceHandler(cfg, ctx);
        } catch (err) {
          console.warn(`${LOG} 选项点击功能安装失败（不影响排版）：`, err);
        }

        // 会话是动态挂载的：会话容器本身出现时补一次观察。
        const hostWatch = new MutationObserver(() => {
          observeHosts();
          schedule();
        });
        hostWatch.observe(doc.body, { childList: true, subtree: true });

        ctx.effect(() => () => {
          disposed = true;
          observer.disconnect();
          hostWatch.disconnect();
          if (timer) window.clearTimeout(timer);
          if (removeChoiceHandler) {
            try { removeChoiceHandler(); } catch { /* 已卸载 */ }
            removeChoiceHandler = null;
          }
          for (const body of touched) {
            try { restoreBody(body); } catch { /* 已卸载 */ }
          }
          touched.clear();
          releaseScope();
          // 样式元素留着也无害，但卸载就干净点：只有本插件创建的那一个才删。
          const el = doc.getElementById(STYLE_ID);
          if (el && el.dataset && el.dataset.plugin === PLUGIN) el.remove();
        }, `${PLUGIN}: observer + styles`);

        return { scan };
      }

      return {
        // 只要 sessions：闸 1 靠它读 agentPreset。
        // 不 inject 'slots' —— 本插件不注册任何槽位，少一个依赖就少一处可能挡启动的地方。
        inject: ['sessions'],
        apply,
        // 供测试与调试
        __test: {
          parseMessage,
          renderMessage,
          buildCSS,
          findBodyIn,
          confirmBody,
          isAcceptable,
          passesThreshold,
          isTavernSession,
          presetOf,
          sessionIdOf,
          renderInto,
          restoreBody,
          DEFAULTS,
        },
      };
    },
  });
})();
