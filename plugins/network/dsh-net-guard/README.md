# dsh-net-guard

进程内出站网络**自愈**（宿主插件，无 client bundle）。

## 为什么需要它

DSH 启动时，`@deepseek-ai/dsh-http-proxy` 会从**启动环境**解析一次代理策略，装成 undici 的全局 dispatcher。
之后所有 LLM 请求、web 搜索、HTTP MCP 都经由它。

问题在于：进程环境是启动那一刻从父进程**拷贝**的，之后外部怎么改都没用；dispatcher 也是启动时构造的，
端口后来恢复也不会自愈。于是这条故障链必然复发：

```
父进程带着 HTTP_PROXY=127.0.0.1:X 启动 DSH
         ↓  进程内永久留着这个值
X 上没人监听了（代理软件换端口 / 临时桥接被回收 / 上游进程退出）
         ↓
所有 fetch → ECONNREFUSED（http 0）→「所有模型都不可用」
```

报错文案会把人引向「换模型」，实际是网络出口坏了。这个插件就是为这条链写的。

## 它做什么

激活时读一次本进程环境，只看 **loopback 代理**（`127.0.0.0/8` / `localhost` / `::1`）。
声明了 loopback 代理而那个端口没人监听 → 删掉代理环境变量、装直连 dispatcher，
写一行明确结论到日志，并让 `net_guard_status` 工具随时可查。

## 它刻意不做什么

- **不动非 loopback 代理。** 远端代理不可达可能是企业网络/审计要求，静默切直连会绕过策略。那种情况只记录，不修改。
- **不改任何配置文件。** 只改本进程的运行时状态。
- **卸载时不恢复旧 dispatcher。** 恢复只会把已经修好的进程重新弄坏。
  （补充事实：launcher 自己的 `disposeProxy` 确实会 `setGlobalDispatcher(previous)` 把代理装回去，
  但 `dispose()` 只在**进程关闭**或**启动失败**时调用，profile 运行期重载不会触发。
  所以运行期不存在「被装回去」的窗口。）
- **不启动/重启任何进程。**

## 已知边界

- 依赖 undici 的 legacy 全局槽位 `Symbol.for('undici.globalDispatcher.1')`。
  这是 DSH 官方文档自己承认的「跨版本隐式耦合，不是约定」，Node 大版本升级后需要复验。
- `proxyEnvironmentForChild()` 在 launcher 安装时就快照了用户原始环境；本插件删掉 `process.env` 之后，
  **那份快照**仍会把旧值传给子进程。子进程侧需另行处理。
- 救不了「插件没被加载」的情况（profile 损坏、插件被禁用）。

## 工具

| 工具 | 干什么 |
|---|---|
| `net_guard_status` | 报告当前出站网络状态：dispatcher 是直连还是代理、启动时是否声明了死代理、自愈是否已生效 |

## 日志

结论写在 `$DSH_HOME/logs/net-guard.log`。
