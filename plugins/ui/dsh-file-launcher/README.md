# dsh-file-launcher

把 DSH 聊天里的文件变成**点一下就运行 / 打开 / 定位**的链接。

> **当前状态（2026-10-03 21:38）：v0.2.1，方案已实测通过，待重启 DSH 生效。**
> - 源码：`D:\DeepSeek-Workspace\dsh-file-launcher`（改这里，改完重启 DSH）
> - 已挂载：`D:\DeepSeek-DSH\profiles\desktop\node_modules\dsh-file-launcher`（Junction）
> - profile `package.json` 已加 `dependencies` + `dsh.profile.bundles`（备份 `package.json.bak-launcher-20261003200355`）
> - 离线自测 **43/43** 通过（`node dsh-file-launcher/selftest.mjs`）
> - **端到端实测通过**：在侧边栏里点 `http://127.0.0.1:19587/dsh-launcher/open?...` → 真的弹出了命令行窗口，脚本真的跑了
> - **Office/PDF 实测通过**：`.docx` 走 `open` → WPS 窗口真的起来了（本机关联：`.docx`→Word、`.xlsx`→WPS 表格、`.pdf`→WPS PDF）
> - 重启后自检：`http://127.0.0.1:19587/dsh-launcher/health` 应返回 `{"ok":true,...,"version":"0.2.1",...}`

## 它解决什么问题

DSH 聊天里的蓝色文件名是**文件引用链接**，语义是「在侧边栏预览」，不是执行。
所以主人想跑一个 `.cmd`，只能自己去资源管理器里翻出文件再双击——很别扭。

本插件注册一层本地 HTTP 路由，把「运行 / 打开 / 定位」变成一条可点的链接：

```
http://127.0.0.1:19587/dsh-launcher/open?t=<token>&p=<绝对路径>&m=run
```

点一下，动作就在 DSH 宿主机上发生了，不用找文件、不用拖拽。

## ⚠️ 为什么必须单开一个端口（本插件最核心的一条设计）

**链接绝对不能挂在 DSH 自己的端口（19387）上。**

DSH 桌面版是 Electron，侧边栏那个「浏览器」用的是 `<webview>`。它会对本机地址做拦截，
报错文案两条，容易看混：

| 现象 | 出处 | 含义 |
|---|---|---|
| 「页面加载失败；请刷新重试或在系统浏览器中打开。」 | `commandFailed()` → `failed()` | **加载**被拒（Electron 层） |
| 「不能在嵌入浏览器中打开 DSH 应用自身。」 | `parseBrowserAddress()` → `reason: "application-origin"` | **地址校验**被拒（前端层，精确比对 origin） |

实测记录（2026-10-03）：

| 链接 | 结果 |
|---|---|
| `http://127.0.0.1:19387/dsh-launcher/…`（同 origin） | ❌ 页面加载失败 |
| `http://localhost:19387/dsh-launcher/…`（**换主机名**，origin 已不同） | ❌ 页面加载失败 |
| `http://127.0.0.1:19587/dsh-launcher/…`（**换端口**） | ✅ **弹出命令行窗口，脚本真的跑了** |

结论：**前端只挡完全相同 origin，Electron 那层是按端口挡的**——换主机名没用（`localhost`
照样红字），只有换端口能过。所以插件必须自己开一个 `http.createServer`
（`DEFAULT_PORT = 19587`），链接打在它上面。

旁证：宿主服务器只绑 `127.0.0.1`，`127.0.0.2` / `127.0.0.3` / `[::1]` 都不通，
所以「换回环 IP」这条路也走不通。

## 两个出口

| 出口 | 地址 | 给谁用 |
|---|---|---|
| **直连口**（自己开的 server） | `http://127.0.0.1:19587/dsh-launcher/…` | **给主人点的链接必须走这个** |
| **宿主口**（挂进 DSH webServer） | `http://127.0.0.1:19387/dsh-launcher/…` | 与 GUI 同源，给客户端插件 / 健康检查用 |

两个口共用同一套 handler 和同一个 token：

- `GET /dsh-launcher/open?t=<token>&p=<路径>&m=<动作>` → 返回一张回执页（加 `&json=1` 返回 JSON）
- `GET /dsh-launcher/health` → 探活

## 动作（`m` 参数）

| m | 行为 |
|---|---|
| **`auto`** | **默认**。按扩展名自动选：`.cmd`/`.bat`/`.ps1`/`.exe` → `run`；**其余一切**（`docx`/`xlsx`/`pptx`/`pdf`/图片/`txt`…）→ `open`。递文件时不用猜动作，也保证文档永远不会被误执行 |
| `run` | 执行。`.cmd`/`.bat` → 新控制台窗口跑；`.ps1` → `powershell -NoProfile -ExecutionPolicy Bypass -File`；`.exe` → 直接起；其他 → 交给系统默认程序 |
| `open` | 用系统默认程序打开（Word / WPS / Excel / PDF 阅读器…） |
| `reveal` | 打开资源管理器并**选中**该文件 |
| `folder` | 打开文件所在文件夹 |
| `edit` | 用记事本打开 |

## 工具（给 AI 用）

`open_local_file({ path, mode, action })`

- `action=link`（默认）只生成可点链接，AI 把 `url` 作为 markdown 链接贴进回复；
- `action=exec` 立刻执行。

链接的 base 是**调用时**才取的（直连口端口是异步就绪的），优先级：直连口 → 宿主口。

> 注：`@deepseek-ai/dsh-tools` 由 DSH 运行时按包名别名解析，profile 的 `node_modules` 里
> 并没有这个包。所以 `index.js` 用顶层 `await import` + try/catch 兜底：
> 万一解析不到，链接通道照样能用，只是少一个工具。

## 安全

- 两个口都只监听 `127.0.0.1`；所有动作都要带 token。
- token 与端口都落盘在 `~/.dsh-launcher.json`，**跨重启续用**：

  ```json
  { "version": "0.2.0", "token": "……",
    "launcherBase": "http://127.0.0.1:19587", "launcherPort": 19587,
    "route": "/dsh-launcher", "dshBase": "http://127.0.0.1:19387",
    "pid": 12345, "startedAt": "……" }
  ```

  两个都必须续用：token 变了，之前给出的链接全部 403；端口变了，旧链接直接连不上。
- 链接是**服务端副作用**：GET 即执行。别把带 token 的链接贴给外人。

## 已知边界

- **进程生命周期**：从 DSH 里启动的进程随 DSH 一起退出（实测 `Start-Process`、`cmd /c start`、WMI、`schtasks` 四条逃逸路线在本机全部不可用）。
  所以「必须在 DSH 关闭后才能跑」的脚本（例如清理 bili 会话文件）仍然只能由主人双击运行。
- 直连口是**插件进程的一部分**，DSH 一关它就没了——这是预期的，不是 bug。
- 端口被占时自动 +1 重试（最多 25 次），实际端口记在状态文件里。

## 安装

插件源码在工作区，通过目录联接挂进 profile：

```
D:\DeepSeek-Workspace\dsh-file-launcher   ←  真身（改这里）
D:\DeepSeek-DSH\profiles\desktop\node_modules\dsh-file-launcher  ←  联接
```

profile 的 `package.json` 需要两处：

```json
"dependencies": { "dsh-file-launcher": "link:D:\\DeepSeek-Workspace\\dsh-file-launcher" },
"dsh": { "profile": { "bundles": [ "……", "dsh-file-launcher" ] } }
```

包自带的 `cordis.patch.yml` 负责把插件插进运行时，**不用**改 profile 的 `cordis.patch.yml`。

改完**重启 DSH** 生效（宿主插件在启动时加载；实测没有热重载——改完 `index.js` 后
19587 并不会自己监听）。

## 后续可做（v0.3）

给交付卡片加一个真正的「运行」按钮，不走浏览器：
官方插槽 `deliverables.file.actions`（内置 `@deepseek-ai/dsh-client-ui-open-in-app` 就挂那儿），
客户端入口是 esbuild 打包的 CJS 包，挂在 `window.__ModuleLoader__.load({ id, factory })` 上，
`id` 必须等于 loader entry 名。好处是不受 webview 端口拦截影响，代价是要引入构建步骤。
