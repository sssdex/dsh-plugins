# Network self-heal

DeepSeek Harness 在启动时从**启动环境快照**解析一次出站代理，并把结果装成 undici 的全局
dispatcher。进程环境是启动那一刻的拷贝，dispatcher 也是启动时构造的——**之后外部怎么改都不会生效**。
于是有一个会反复发生的故障：

```
父进程带着 HTTP_PROXY=127.0.0.1:X 启动 DSH
        ↓  进程内永久留着这个值
X 上没人监听了（代理软件换端口 / 临时桥接被回收 / 上游进程退出）
        ↓
所有 fetch → ECONNREFUSED（http 0）→「所有模型都不可用」
```

2026-11-13 / 11-14 / 11-15 三次故障都是这一条链。

这个插件在激活时读一次启动环境，**只看 loopback 代理**（`127.0.0.0/8`、`localhost`、`::1`）。
如果声明了 loopback 代理而那个端口**明确拒绝连接**，就切到直连 dispatcher 并清理代理变量。

## 安装后你会看到

插件行显示「网络自愈 / Network self-heal」。激活后：

- 日志 `D:/DeepSeek-DSH/logs/net-guard.log`（超过 512 KB 自动轮转为 `.log.1`）
- 新增工具 `net_guard_status`，随时可查当前走哪条路

## 判定结果（verdict）

| verdict | 含义 | 改网络吗 |
|---|---|---|
| `CLEAN_START` | 启动快照里没有任何代理变量 | 否 |
| `CLEAN_START_UNVERIFIED` | process.env 干净，但**拿不到官方快照**，无法排除 `$DSH_HOME/.env` | 否 |
| `PROXIED_REACHABLE` | loopback 代理端口 TCP 可达（**不等于代理协议可用**） | 否 |
| `PROXY_INDETERMINATE` | 探测超时/其它错误，证据不足以判死 | 否 |
| `PROXIED_REMOTE` | 非 loopback 代理（企业网络/审计） | 否，**刻意不动** |
| `DIRTY_START_RESCUED` | **确认死代理，已切直连** | 是 |
| `DIRTY_UNRESCUED` | 死代理但自愈失败，或 `autoHealLoopback=false` | 否 |
| `CONFIG_ANOMALY` | 代理变量解析不成 URL | 否 |
| `DISABLED` | 配置 `enabled=false` | 否 |

另有一个独立的 `action` 字段说明本轮做了什么：
`none` / `rescued` / `skipped_already_handled` / `retryable`。
它**不覆盖** verdict，所以工具始终能回答「现在是代理不确定，还是只是本轮没重复处理」。

## 五个防误伤设计（都是实测或评审踩出来的，别改回去）

1. **只有 `ECONNREFUSED` 才算死。** 超时可能是慢代理或刚启动 → `PROXY_INDETERMINATE`，不动手。
2. **按配置的实际地址族探测。** 显式 `127.0.0.1` 只探 IPv4，显式 `::1` 只探 IPv6；
   只有 `localhost` 才两个栈都试。否则「另一个栈上的无关监听」会让人误判代理还活着而**漏救**。
3. **通配地址归配置异常。** `0.0.0.0` / `::` / `*` 是监听地址、不是可连接目标，
   语义不明 → `CONFIG_ANOMALY`，**绝不自动自愈**。
4. **事务化切换 + 可验证回滚。** 保存原 dispatcher 与环境变量 → 装 direct → 用**对象身份**验证生效 →
   清变量 → 逐项复核 → 任一步失败**回滚**，回滚后按对象身份与逐项值复核；
   **读不到原 dispatcher 时在调用 setter 之前就拒绝**（否则会留下无法回滚的中间态）。
5. **可重试状态不被幂等挡住。** 跳过条件必须**同时**满足：同指纹 + `settled===true` + verdict 属于已定论集合。
   `PROXY_INDETERMINATE`、`DIRTY_UNRESCUED` 都属于可重试，下次激活会重新探测。

## 环境快照不可信时的处理

`launchEnvironment` 是外部对象，可能 `undefined`、可能 truthy 但没有 `get`、
也可能 `get()` 在**第 N 次**调用时才抛异常。

插件**一次性批量读取** 6 个代理变量并缓存：全部成功才算已验证；
**任一**抛异常就**整批丢弃**、全部改从 `process.env` 取，并把 verdict 降级为
`CLEAN_START_UNVERIFIED`、`envSourceVerified=false`，同时打警告。

不能按需逐个读 —— 第一次成功会把「已验证」定死，第 N 次抛异常时外面已经用 true 做了判定，
就会报出一个假 CLEAN。来源必须在读取完成时固定，之后只读缓存。

快照整批成功且明确为空时，采信「没有代理」，不再回看 `process.env`（避免来源混杂）。

## 读的是官方启动快照，不是 `process.env`

launcher 是 `installProxyFromEnvironment(options.environment, ...)`，而 `options.environment`
是三层快照（process / project-env / user-env）。代理可能来自 `$DSH_HOME/.env`，
**只读 `process.env` 会得出假 CLEAN**。所以插件优先用 `ctx.get('launchEnvironment')`，
取不到才退回 `process.env`，并把 verdict 降级为 `CLEAN_START_UNVERIFIED`。

## 配置项

写在 profile 的 `cordis.patch.yml`，目标行 `id: dsh-net-guard`：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 只报告不处理 |
| `autoHealLoopback` | `true` | `false` 时只报 `DIRTY_UNRESCUED`，不修改 |
| `probeTimeoutMs` | `1500` | loopback 探测超时 |
| `logFile` | `D:/DeepSeek-DSH/logs/net-guard.log` | 日志路径 |

## 怎么复验它还灵（Node 升级后必做）

```powershell
cd 'D:\DeepSeek-Workspace\dsh-net-guard'
& 'C:\Program Files\nodejs\node.exe' selftest.mjs        # 80 项分支测试
$env:HTTP_PROXY='http://127.0.0.1:59999'; $env:HTTPS_PROXY='http://127.0.0.1:59999'; $env:NODE_USE_ENV_PROXY='1'
& 'C:\Program Files\nodejs\node.exe' e2e-dirty-boot.mjs  # 端到端：真脏启动 → 自愈 → 真能 fetch
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:NODE_USE_ENV_PROXY
```

端到端通过的样子：`加载前: fetch failed | ECONNREFUSED` → `加载后: HTTP 401 → 可达 ✅`。
`401` 是「可达、只是没 token」，**不是失败**。

## 已知限制（诚实清单）

- **依赖 undici 的 legacy 全局槽位** `Symbol.for('undici.globalDispatcher.1')`。
  这是 DSH 官方文档自己承认的「跨版本隐式耦合，不是约定」，Node 大版本升级后需要复验。
- **`proxyEnvironmentForChild()` 在启动器安装时就快照了用户原始环境。** 本插件删掉
  `process.env` 之后，**那份快照**仍会把旧值传给子进程；子进程侧的代理需另行处理。
- **只修当前进程。** worker、utility process、child process 不在覆盖范围。
- **TCP 可达 ≠ 代理协议可用。** `PROXIED_REACHABLE` 只说明端口有人听；
  407 认证、CONNECT 被 ACL 拒绝、上游 DNS 失败、TLS 中间人证书问题都不在探测范围内。
- **只处理进程启动那一刻的状态。** 运行中才把代理关掉，要重启才会重新判定。
- **插件没被加载就完全没兜底。** profile 损坏、插件被禁用、版本不兼容时，
  脏启动会直接全灭 —— 这时靠 `DSH-Clean-Relaunch` 计划任务（走
  `start-dsh-clean-launch.cmd`，不依赖插件）拿一个干净起点。
- **Windows 环境变量名大小写不敏感**，`http_proxy` 与 `HTTP_PROXY` 是同一个变量。
- 本插件**不修改任何配置文件**，只改运行时状态；卸载时不恢复旧 dispatcher。
