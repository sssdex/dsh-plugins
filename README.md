# DSH Plugins · sssdex

个人自研的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件与预设合集。

这里的工程都是本地 `link:` 加载、插件市场无法更新的自研件 —— 换句话说，**只有这份仓库是它们的上游**。

> **关于重名**：`dsh-advisors`、`dsh-auth-cookie-guard`、`dsh-thinking-guard`、`dsh-agnes` 这四个在 npm 上有同名包，
> 但那是别人发布的独立实现。本仓库里的版本是本地自研的，功能与本机工作流绑定，**不是同一份代码**。

---

## 插件 (plugins/)

按功能分目录，每个子目录是一个独立可加载的 DSH 插件工程。

### `ui/` — 界面与客户端

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-file-launcher](plugins/ui/dsh-file-launcher) | 0.2.1 | 把聊天里的文件变成「点一下就运行 / 打开 / 定位」的链接 |
| [dsh-sidebar-scroll](plugins/ui/dsh-sidebar-scroll) | 0.1.0 | 让右侧栏每个 tab 的正文可以上下滚动，修掉 `.tabBody` 裁切问题 |
| [dsh-pdfium-preview](plugins/ui/dsh-pdfium-preview) | 0.1.0 | PDFium (WASM) 侧边栏 PDF 阅读器，按需光栅化 + 真实文本层 |
| [dsh-client-patchguard](plugins/ui/dsh-client-patchguard) | 0.1.0 | 启动时把本地补丁重新打进已安装插件的客户端 bundle，不写穿 pnpm store |

### `session/` — 会话与上下文

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-token-tree](plugins/session/dsh-token-tree) | 0.1.0 | 父代理 + 全部子孙代理的 token 汇总，右侧栏面板按代理拆明细 |
| [dsh-memory-switch](plugins/session/dsh-memory-switch) | 0.1.0 | 记忆注入的会话级开关，决定本会话是否让记忆系统注入摘要/召回/规则 |

### `agents/` — 子智能体

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-advisors](plugins/agents/dsh-advisors) | 0.1.0 | 只读顾问子智能体：前端审美 / 建模 / 后端设计四个领域可各自指定模型，顾问只给方法不参与实施，带运行时只读守卫 |

### `providers/` — 模型与能力接入

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-agnes](plugins/providers/dsh-agnes) | 0.1.0 | Agnes AI 多模态接入：`agnes_image` 生图（文生/图生/多图合成）、`agnes_video` 生视频（文生/首尾帧/参考素材）+ 任务轮询 |

### `runtime/` — 运行时修复与防护

这类插件不进则退：它们是绕过上游 bug 的补丁层，宿主版本升级后需要重新验证。

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-auth-cookie-guard](plugins/runtime/dsh-auth-cookie-guard) | 1.0.0 | 修 DSH 桌面端「启动即崩」：每次启动新增 `dsh-auth-*` cookie 且从不清理，累积到 71 条约 15.6KB 越过 Node 16KB 头上限触发 431。抬高头上限 + 种新 cookie 时批量删旧，稳态恒为 1 条 |
| [dsh-thinking-guard](plugins/runtime/dsh-thinking-guard) | 0.1.0 | 把第三方中转塞进正文的 `<thinking>…</thinking>` 还原成 `reasoning` 块，让思考回到思考面板而不是当成最终答案 |

### `network/` — 网络

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-net-guard](plugins/network/dsh-net-guard) | 0.1.0 | 进程内出网自愈：检测启动环境继承的死代理并切换到直连 dispatcher |

### `tools/` — 工具与开发

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-asar-tools](plugins/tools/dsh-asar-tools) | 0.1.0 | 让 ASAR 归档可检索：`asar_list` / `asar_grep`，绕开 rg 读不了 app.asar 的限制 |
| [dsh-power-off](plugins/tools/dsh-power-off) | 0.1.0 | 从 DSH 关机：模型工具 + loopback 路由 + 标题栏按钮，可取消（Windows） |
| [dsh-workspace-agent-preset](plugins/tools/dsh-workspace-agent-preset) | 0.2.0 | 为每个工作区单独指定默认 Agent 预设、模型与推理等级 |

### `tavern/` — 酒馆

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-tavern-render](plugins/tavern/dsh-tavern-render) | 0.1.0 | 把酒馆的结构化回话（正文/状态/动态/聊天/选项）渲染成有层级的界面 |
| [dsh-tavern-model-handoff](plugins/tavern/dsh-tavern-model-handoff) | 0.1.0 | 开局用中转站 flash 读卡，读完自动切到主模型出正文 |

### `integration/` — 外部接入

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-qq-hands](plugins/integration/dsh-qq-hands) | 0.1.0 | 在 QQ 里主动发消息、表情包、语音、截图、文件，长回复按句拆成多条气泡 |

---

## 预设 (presets/)

纯 YAML 配置（`cordis.patch.yml`），不含插件代码，加载方式与插件不同。

| 预设 | 说明 |
|---|---|
| [dsh-tavern-preset](presets/dsh-tavern-preset) | 酒馆扮演预设，含读卡与宏处理工具链 |
| [fast-solver-preset](presets/fast-solver-preset) | 快速解题预设 |
| [file-fast-preset](presets/file-fast-preset) | 文件速读预设，带 `restrict.js` / `tune.js` 调参 |
| [preset-cmp-a](presets/preset-cmp-a) | 精简·lean —— 保守版 standard 预设 |
| [preset-cmp-b](presets/preset-cmp-b) | sprint 预设 |
| [preset-cmp-b-high](presets/preset-cmp-b-high) | sprint 高推理版本 |
| [preset-cmp-b10](presets/preset-cmp-b10) | sprint10 版本 |

---

## 怎么用

插件工程结构是标准的 DSH bundle（`package.json` + `cordis.patch.yml` + 入口 JS），在你的 profile 里链接后重启 DSH 生效：

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": { "dsh-asr-tools": "link:D:\\path\\to\\dsh-asar-tools" },
  "dsh": { "profile": { "bundles": [ /* ...其他 bundle... */, "dsh-asar-tools" ] } }
}
```

```powershell
cd $env:DSH_HOME\profiles\<profile>
pnpm install
# 重启 DeepSeek Harness
```

> `link:` 会建目录联接指回源码，改代码不用重新复制。但宿主插件改完**必须重启**才生效：
> profile 的 patch 改动可以被 HMR 热应用，已加载的 JS 模块不会重新 import。

预设则按 YAML 方式载入，具体见各目录下的 README。

---

## 警示

这些是按个人工作流长出来的东西，没有做过通用性适配。拿走之前建议先读源码 —— 尤其是：

- **`dsh-power-off`** —— 真的会关机
- **`dsh-client-patchguard`** —— 会改写已安装插件的客户端 bundle
- **`dsh-qq-hands`** —— 会操作 QQ 客户端，可能涉及账号风险
- **`dsh-auth-cookie-guard` / `dsh-thinking-guard`** —— 依赖对宿主内部实现的假设，宿主升级后可能失效甚至帮倒忙

## License

未指定。这些是私人工具，取用前请自行评估。
