# 工作区预设 · dsh-workspace-agent-preset

在设置页左侧导航里新增一节，为**每个工作区单独指定默认的 Agent 预设、模型和推理等级**。

## 它解决的问题

DSH 只有一个全局默认预设和一个全局默认模型（设置 → Agent 预设 / 模型）。同一个进程里同时开着
「解题模式」和「写代码」两个项目目录时，新建会话永远从同一套配置起步，每次都得手动改。

装上这个插件后：设置页多出一节「工作区预设」，每个工作区一张卡片，选完即生效——该工作区里
**新建**的会话直接跑你指定的预设 + 模型 + 思考强度。

## 规则（重要）

| 场景 | 结果 |
| --- | --- |
| 在 A 工作区点「新建任务」，且没手动挑预设/模型 | 用 A 工作区配的预设与模型 |
| 在 A 工作区手动挑了预设或模型 | **以你挑的为准**，插件不覆盖 |
| 在空白会话里先手动选了模型，再复用它新建 | 保留你选的模型：插件只补「还没记录过选择」的会话 |
| 已在进行的会话 | 保持它自己的预设与模型，不受影响 |
| 工作区没配（「跟随全局默认」） | 用全局默认，与没装插件时一致 |
| 配的预设后来被卸载/改名 | 自动退回全局默认，卡片标黄提示，**不会**让新建会话报错 |
| 配的模型后来从目录里消失 | 同上：退回全局默认并在卡片上标出失效的模型 |
| 配的推理等级模型后来不支持了 | 注入前先校验，不被支持就保持全局默认并写警告日志 |

预设和模型**互相独立**：清空其中一项不会动另一项。

## 安装

```
plugin_manager: install_bundle
target: D:\DeepSeek-Workspace\dsh-workspace-agent-preset
```

- **浏览器半侧**（界面）会随包重建自动热替换，刷新设置页即可看到。
- **Host 半侧**（注入逻辑）改动后需要重启 Host 进程才生效——它已经被 Node 的 ESM 缓存加载过。

## 配置

`$DSH_HOME/workspace-agent-preset/assignments.json`：

```json
{
  "version": 2,
  "assignments": {
    "d:\\解题模式": {
      "presetId": "fast-solver",
      "model": { "provider": "workbuddy", "model": "deepseek-v4.1-flash", "reasoningEffort": "low" }
    }
  }
}
```

键是工作区目录的 realpath（Windows 下已小写化，因为文件系统不区分大小写）。
`version: 1`（值是裸预设 id 字符串）的老文件仍能读，读进来就是「只有预设」。

插件行本身支持两个配置项（写在 profile 的 `cordis.patch.yml` 里覆盖该行 `config`）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | `false` 只保留设置页读写，不再影响新建会话 |
| `log` | `false` | `true` 时把每次注入写进 Host 日志，排查用 |

## 实现要点

- **配置存哪**：Workspace 注册表由 `@deepseek-ai/dsh-workspace` 拥有，不提供插件扩展
  字段，所以映射单独存一份 JSON，用原子写（临时文件 + rename）。
- **怎么影响预设**：Web 客户端只有在**手动挑选**时才在 `session/create` 里带
  `agentPreset`；侧边栏「新建任务」什么都不传，Host 就落到全局默认。插件在
  `sessionController.create` 上装一个自己的实现，在预设解析**之前**补上
  `agentPreset`，请求里本来就带预设时原样放行。
  这个包装能生效，是因为 API Gateway 每次调用都是
  `Reflect.get(callReceiver, descriptor.method)` 现取方法（见 `dsh-api-gateway` 的
  `prepareInvocation`），实例上的自有属性覆盖会被取到；`dsh-mcp-manager` 用同样的
  方式包 `agents.create` / `agents.resume`。
- **怎么影响模型**：`SessionCreateRequest` 里**没有**模型字段，会话创建时必然先带上
  全局默认。所以插件在 create 返回之后拿到 live Agent，调用
  `agent.model.select({ provider, model, reasoningEffort })`，写下和解
  `sessionController.selectModel` 完全相同的 `model/selection` 事件；循环在每一步
  之前读 `agent.model.current()`，因此**第一条请求**就已经跑在工作区的模型上。
  包装里 `await` 了这次安装，所以 create 返回即可用。
  **关键区别**：`selectModel` 会顺手 `agentDefaultModel.saveSelection()`，把工作区
  选择写成整个部署的默认——那是副作用，插件改用 `agent.model.select` 只落到
  这一个会话上，全局默认不受影响。
- **不覆盖你已有的选择**：`create` 会复用已存在的空白会话，而 composer 允许在空白
  会话上就先挑模型。所以注入前先读 `agent.model.recordedSelection()`（读不到就回退到
  日志里倒着找 `model/selection`），**有记录就不动**，自检显示「该会话已自选 X」。
  注意不能拿 `agent.model.current()` 判断：它对没选过的会话也会回落到构造参数里的
  全局默认，那样会永远判成「已选」。
- **注入前校验**：`llm.resolveCallConfig(selection)` 会按适配器能力物化默认值，
  并拒绝模型不支持的推理等级；校验不过就不注入，只写警告。这一层纯本地
  （`dsh-llm-pi-ai` 的 `resolveModel` 读内存快照），不产生网络请求，结果按
  selection 记忆，不会每次建会话都查。
- **为什么不监听事件补救**：`agent/created` 之后再用 `agentPresets.select()` 切换，
  要依赖「会话还空白」这个竞态窗口，且会多写一条 `agent-preset/selected`；更关键的
  是它**分不清「用户显式选了默认」和「没选」**（省略时 header 已被默认值污染）。
  在创建入口注入则是同一条路径，日志记录与实际运行一致。
- **路由**：`api/workspace-agent-preset.state`（读）与
  `api/workspace-agent-preset.assign`（写）挂在 `/api` 共享通道上，Host/Origin 围栏
  与 owner Peer 鉴权由 `ctx.connection` 先行完成。`assign` 接受
  `{ path, presetId }`、`{ path, selection }` 或两者；只改你点名的那一项。

## 注入自检（为什么需要）

实例覆盖依赖 `dsh-api-gateway` 的 `prepareInvocation` **每次调用现取方法**这一实现
细节。同一个文件里已有「沿原型链取实现」的写法（`methodParameterNames`），所以未来
版本若改成原型查找，覆盖会**静默失效**——不报错，只是不生效。

为此插件把每次真实注入的结果和自己请求的值做比对，结论显示在设置页底部：

| 显示 | 含义 |
| --- | --- |
| 注入自检通过：<预设> 已被实际采用 | 预设覆盖在调用路径上，工作正常 |
| 注入自检失败：请求 X，实际运行 Y | 覆盖被绕过，插件未生效（同时写 Host 警告日志） |
| 模型自检通过：<模型> 已被实际采用 | `agent.model.select` 写下的选择被 Agent 读回一致 |
| 模型自检：该会话已自选 X | 复用的空白会话本来就有选择，插件没动它（这是正确的） |
| 模型自检失败：请求 X，实际运行 Y | Agent 没接受这次选择（同上写日志） |
| 尚未验证：… | 还没在该工作区新建过会话 |

## 自测

```
node selftest.mjs       # Host 半侧：23 项
node client-probe.mjs   # 浏览器半侧：16 项（自带极简 React 渲染器）
```

`selftest.mjs` 用临时 `DSH_HOME` 跑，覆盖：路径归一化、selection 归一化、
`recordedSelection` 的两条读取路径、方法包装的安装/还原、按 workspaceId 注入、
按 cwd 注入、显式预设不被覆盖、未配置目录不受影响、清空单项不伤另一项、
未知模型/坏 selection/空变更被拒、失效预设与失效模型降级、v1 存储兼容、
v2 双字段持久化、复用已选模型的会话不被覆盖、create 拒绝仍向上抛。

`client-probe.mjs` 在无浏览器环境下加载真实 `lib/client.js`，覆盖：slot 注册、每工作区
三件套渲染、按 provider 分组的模型下拉、推理等级行只在有效力时出现、默认值标记、
失效模型/预设的标黄、自检行、六种选择路径发出的请求体、保存失败的错误展示、中英
字典键一致。
