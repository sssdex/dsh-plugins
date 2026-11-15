# dsh-advisors

给主智能体配一个**只读顾问**：遇到前端审美、建模、后端设计问题时，开一个真子智能体去问方法与建议，
顾问**绝不参与实施**。

## 它解决什么问题

主模型在「怎么做」上很强，但在没有领域约束的时候容易给出模板化的、想当然的方案。
这个插件把「想清楚再说」拆成一个独立环节：

1. 主智能体调用 `ask_advisor`，指定领域（前端 / 审美 / 建模 / 后端）；
2. 插件按该领域配置的模型起一个**只读**子智能体；
3. 顾问返回结构化的方法与建议；
4. 主智能体拿着建议继续实施 —— 实施由主智能体做，顾问不碰。

## 四个领域各自可指定模型

设置页里每个领域可以单独选 provider + model。默认全 GPT-6 Astra，可改。
运行时 `ask_advisor` 严格按选择派发，不是摆设。

配置持久化在 `$DSH_HOME/dsh-advisors.json`，含 `routes`（领域 → 模型）与 `sessions`（会话级开关）。

## 运行时只读守卫

顾问的 agent scope 上挂 `agent.ctx.tools.guard()`，任何越界的宿主级工具调用在 `ToolsService.checkGuards(exec)`
这一层就被拦下，物化成 `isError: true` 的 `Error: <reason>` 结果，**不进入 dispatch**。

> 诚实说明：这一段的证据强度分两半。挂载与判定逻辑有 `test/host-probe.mjs` 覆盖；
> 「`agent.ctx` 的 scope 确实等于 `exec.agent` 的 scope」是对 `dsh-scope` 的 `ScopedLayers` 源码推断，
> **尚未用一次真实越界调用证伪或证实**。详见 `HANDOFF.md` 第 0 节。

## 会话级开关

模型菜单里一行开关，决定本会话是否启用顾问咨询。`defaultEnabled` 控制新会话默认值，会话显式值优先。

## 文件职责

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半边：`ask_advisor`、只读守卫、HTTP 路由、模型目录、路由优先级 |
| `client.js` | 客户端半边：模型菜单开关行 + 设置页（四领域下拉、默认开启） |
| `cordis.patch.yml` | `preset-advisor`（只读预设）+ `dsh-advisors`（插件本体） |
| `docs/DETAIL.md` | 设计细节 |
| `HANDOFF.md` | 交接文档，含踩过的坑与证据强度说明 |

## 踩过的坑（值得记住的）

_client 注册 id 必须等于包名_，否则 ModuleLoader 报 `loaded without registering dsh-advisors`。

_`loadState()` 曾经把用户的选择整个吞掉_：原实现只挑出 `sessions` 返回，`routes` 被丢掉，
表现为「设置页改了模型，重载后静默失效但界面还显示旧值」。这个 bug 只有「写 → 重载 → 再读」才能发现，
单看代码很像对的。回归断言在 `test/host-probe.mjs`。

_原生 `<select>` 在深色主题下不可用_，下拉控件是自绘的。

## 测试

```bash
npm test        # 192 条离线断言
```

---

> npm 上有同名包 `dsh-advisors`（维护者 btboys），那是另一个独立实现。本仓库这份是本地自研版本。
