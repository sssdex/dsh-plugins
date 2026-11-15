# dsh-power-off

让 **DeepSeek Harness 真的把电脑关机**（不是重启 DSH、也不是退出 DSH）。

市面上几个叫「电源 / power」的 DSH 插件，实测源码后都只做后两件事：
`dsh-power-button`、`dsh-power-xc`、`dsh-power`、`dsh-page-refresh` 里
**没有任何一处调用 `shutdown.exe /s`** —— 它们重启或退出的是 DSH 进程本身。
而「任务完成后自动关机」那一类（`dsh-auto-shutdown` 等）是**挂机**场景，
不给你手动立刻关。

本插件补的就是这一格：**AI 一句话关机** + **界面上点一下关机**，都能反悔。

## 三个出口

| 出口 | 怎么用 |
| --- | --- |
| 模型工具 `shutdown_computer` | 你跟 AI 说「关机」，它自己调；`action=shutdown` / `cancel` / `status` |
| 会话标题栏按钮 | 标题栏右侧「关机」按钮：点一下 → 确认 → 系统倒计时；倒计时里再点 = 取消 |
| HTTP | `POST /api/dsh-power-off/shutdown`、`/cancel`、`GET /state` |

## 它到底执行什么

```
shutdown.exe /s /f /t 60 /c "DSH 关机：由 dsh-power-off 插件触发"
取消：shutdown.exe /a
```

`/t 60` 是系统层面的倒计时（默认 60 秒，可配 10–3600）：这 60 秒里
**任何一端都能撤销**——再点一次按钮、让 AI 调 `cancel`、或者直接开个 cmd 敲
`shutdown /a`。`/f` 会强制结束阻止关机的程序，不加的话可能卡在「这些应用
阻止关机」的确认界面，自动化就白做了。

## 安装

```powershell
& 'D:\Programs\DeepSeek-Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop add link:D:/DeepSeek-Workspace/dsh-power-off
```

装完刷新页面（本机 profile 会热加载；没有热加载就重启一次 DSH）。
标题栏右侧出现「关机」按钮、模型工具列表里出现 `shutdown_computer` 即为成功。

## 配置

在 profile 的 bundle patch 里覆盖（或改包内 `cordis.patch.yml`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `defaultDelaySeconds` | `60` | 系统倒计时秒数；按钮和模型工具不传时用它 |
| `minDelaySeconds` | `10` | 下限，传更小的会被夹上来 |
| `maxDelaySeconds` | `3600` | 上限 |
| `force` | `true` | 加 `/f` 强制结束阻止关机的程序 |
| `allowModelTool` | `true` | 是否注册 `shutdown_computer` 工具 |
| `dryRun` | `false` | `true` 时只把将要执行的命令写进日志，不真下发给系统 |

想先空跑一遍看命令对不对，就把 `dryRun: true` 打开。

## 安全

- **只认本机**：socket 远程地址必须是回环（`127/8`、`::1`、IPv4-mapped），
  `Host` 头也必须是回环权威；有 `Origin` 时必须与 `Host` 同源。
  别的网页就算知道你端口也调不动。
- **跨站请求直接拒**：`sec-fetch-site: cross-site` 一律 403。
- **留足反悔窗口**：默认 60 秒系统倒计时，不是立刻断电。
- **断电前的最后一道闸**：DSH 挂了也不影响已经下发的 `shutdown /t`（那是
  Windows 在数，不是插件在数）；反过来，`/a` 在 DSH 之外手动敲同样有效。
- 日志：`$DSH_HOME\dsh-power-off.log`（每次下发 / 撤销都记一行 JSON）。

## 自检

```powershell
node selftest.mjs     # 16 项：围栏 / 路由形状 / 参数夹取 / argv 拼接（dryRun，不真关机）
node spawncheck.mjs   # 真机链路：只跑 shutdown /a（取消），不安排任何关机
```

`spawncheck.mjs` 故意只测 `/a`：没有待处理关机时 `shutdown.exe /a` 返回
`1116`（`ERROR_NO_SHUTDOWN_IN_PROGRESS`），系统状态不变，是唯一能反复跑的真实链路验证。
**它绝不会跑 `/s`。**

## 已知边界

- **仅 Windows**（`shutdown.exe`）。
- 关机是系统级不可逆动作：`/t` 倒计时结束就真断电，没保存的工作会丢。所以默认 60 秒、按钮带确认框。
- 与「任务完成后自动关机」类插件可以共存，但**别同时武装两边**：它们各自数各自的倒计时，
  谁也不认识谁，可能出现一方刚取消、另一方到点照关的情况。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：回环围栏、三条路由、`shutdown.exe` 下发、`shutdown_computer` 工具 |
| `client.js` | 浏览器半：会话标题栏的关机按钮（无构建，经典外链脚本） |
| `cordis.patch.yml` | bundle patch：一个宿主行 |
| `selftest.mjs` / `spawncheck.mjs` | 自检 |

## License

MIT
