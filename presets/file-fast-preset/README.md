# 文件·快刀（file-fast）—— 专做文件读写的快速 Agent 预设

给 DeepSeek Harness 加一个「只做文件、少想快做」的 agent 预设。目标是让改文件这件事接近豆包那种手感，而不是等模型推演几分钟。

## 它解决什么

本机 2026-11-11 实测（解码 254 个历史会话、5002 个 step）：

| 现象 | 数据 |
|---|---|
| 一个 22 步的改文件会话 | 总耗时 652s，其中**工具执行只有 19s，模型思考 632s（97%）** |
| 思考量 vs 该步耗时 | 相关系数 **0.937**；几乎不思考 3.2s，超大思考 15.5s |
| 写文件本身 | `write` 32ms、`read` 9ms、`edit` 几十 ms |
| 工具注入 | 每步 82~112 个工具，schema 约 104KB ≈ **3 万 token** |
| 从未被调用过的工具 | 82 个里有 **29 个**在 254 个会话里一次都没用过 |

所以「慢」不是改文件慢，是**想得太久 + 工具盘太重**。这个预设就针对这两点。

## 三层设计

**1. 把工具从 80+ 砍到 19**

只保留：`read` `write` `edit` `read_image` `glob` `grep` `pwsh` `bash` `convert_to_markdown` `read_pdf` `async_parse_pdf` `job_output` `job_kill` `job_list` `present` `open_local_file` `ask_user_question` `load_workspace_dependencies` `skill`。

`restrict.js` 在预设作用域上挂一个 deny 掩码，把其余全部挡掉。用 deny 而不是 allow 是因为掩码语义是「取交集」：allow 反复施加会越收越窄，deny 反复施加是并集，可以累积、幂等。它还会监听 `tools/change`，之后新注册的插件（MCP 服务器、灵枢等）同样被挡在门外。

> **`job_output` 必须在列表里。** `async_parse_pdf`（mineru 的扫描件解析）只返回一个 `job_id`，结果得靠 `job_output` 取。第一版漏了这三个 job 工具，结果是「提交成功但拿不到内容」。

> GitHub Copilot 把工具从 40 降到 13，首 token 延迟 -190ms、成功率 +2~5pp。工具越多选错概率越高，schema 还是每一步的固定成本。

**2. 把 `reasoningEffort` 从 max 降到 low**

`tune.js` 在 `agent/created` 时把推理强度调低。它先查 `ctx.llm.resolveModel()` 该路由真实支持的档位，不支持就不动——宁可慢，不会把会话弄坏。只降不升。

**3. 用提示词教它怎么用工具（这是核心）**

预设用了 `complete: true`，意味着**系统提示词只剩下面这一段**，包括 DSH 自带的工具指引段（"read before write" 之类）全部被吞掉。所以工具使用规则必须自己写全，`persona` 里写的就是这一份：

- 新建文件直接 `write`，不必先 `read`
- 改已有文件：先 `read`（用 offset/limit 只取需要的行），再 `edit` 一次到位
- 一个文件改多处 → 一次 `write` 重写比三次 `edit` 更快更稳
- 找文件：`glob` 定位 → `grep` 找内容 → 最后才 `read`
- 无依赖的读操作一次性并行发出
- 批量/格式化任务用 `pwsh` 跑脚本，不要让模型逐行处理
- docx/xlsx/pptx 先调 `skill` 拿 office-* 打法，不盲写 OOXML
- **改完就答**：不回读、不"验证一下"、不贴 diff、3 句话内说完

## 怎么用

1. **新建一个会话**（预设只在空白会话可选，已有内容的会话改不了）。
2. 输入框旁的预设下拉选 **文件·快刀**。
3. 直接说要改什么。

想设成默认，把 profile 的 `cordis.patch.yml` 里 `agent-preset-registry` 的 `selectedDefault` 改成 `file-fast`。

## 文件

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | 预设声明：persona + 工具行清单 |
| `restrict.js` | 工具收窄器（deny 掩码，失败安全） |
| `tune.js` | 推理强度调低（先查能力再设） |
| `package.json` | bundle 声明 |

改完任何文件：`plugin_manager` `remove_bundle` → `install_bundle`，然后**重启 DSH**（替换已安装的包需要重启才能加载新的 JS 模块代次），最后新建会话验证。

## 已知边界

- **会丢能力**：没有 `web_search`、`subagent`、`todo_write`、`plan_mode`、`workflow`。要查资料、要拆大批任务时切回 **standard**。
- **`complete: true` 的代价**：DSH 自带的其他提示词段全部失效，包括 plan-mode 指引和各类工具说明。这个预设的 persona 是它唯一的行为依据，改它等于改整个 agent 的脑子。
- **验证口径**：本次只做到「预设正确出现在组合后的配置树、13 个插件行齐备、persona 文本完整」。**尚未跑真实会话做端到端 A/B**——需要新开会话实测才算数。
- 预设不是沙箱：preset 里的 YAML 和 JS 能执行 Host 代码。

## 2026-11-11 事故复盘（三个问题）

### 0. 「预设从下拉框里消失了」——不是预设坏了，是被从 bundles 删了

时间线：13:05 有人（侧边对话 / 豆包）把 `profiles/desktop/package.json` 的
`dsh.profile.bundles` 里这一行删掉了：

```json
"@local/dsh-file-fast-preset"
```

依赖声明还在、软链还在、预设文件全在，但 **bundle 不在 bundles 列表里 = 整个预设不会被加载**，
所以下拉框里没有它。

留档备份：`package.json.bak-filefast-disable-20261111-130519`（删之前）、
`package.json.bak-restore-filefast-*`（恢复之前）。恢复后当前文件与该备份**逐字节一致**。

> 排查口径：预设不出现时，先看 `dsh.profile.bundles`，再看依赖和软链。
> 三者缺一都表现为「下拉框里没有」。

### 1. `file-fast-tune: Cannot read properties of undefined (reading 'validate')`

`tune.js` 导出了一个 `Config`，写的是 schemastery 的 **JSON 描述字面量**，
不是 `z.object()` 造出来的 schema：

```js
// ✗ 错的——cordis 拿它当 StandardSchemaV1 去调 .validate，直接崩
export const Config = {
  reasoningEffort: { type: 'union', dict: { unset: 1, low: 1, high: 1 }, default: 'low' },
};
```

cordis 的 `plugin.Config` 必须是带 `~standard.validate` 的 StandardSchemaV1。
本包是 link 安装、目录下没有 `node_modules`，**import 不到 `@deepseek-ai/schemastery`**，
所以也写不出 `z.object()`。

**改法：不导出 `Config`**，取值校验挪进 `apply()`（`EFFORTS.has(target)`，等价且零依赖）。

### 2. `tool-workspace-dependencies: invalid config: $.source missing required value`

预设里重复声明了一行 `@deepseek-ai/dsh-tool-workspace-dependencies` 却没给 `config`。
它的 `source` 是 **required 的绝对路径**。Desktop 已经在 profile 层通过 `desktop-office`
挂载它了（`source` 来自 `--primary-runtime`），祖先层已注册的同名工具本来就对预设可见。

**改法：删掉那一行。**

### 3. 静默失效：`llm.resolveModel` 根本不存在

`tune.js` 里查模型能力调的是 `ctx.llm.resolveModel(provider, model)`，
但 **llm 服务上没有这个方法**——`resolveModel` 是 adapter 内部的，正确的是
`resolveModelInfo(provider, model)`。原写法每次都抛 `TypeError` 被 `catch` 吞掉，
表现为「预设装上了、推理强度却从来没变过」。已改成 `resolveModelInfo`。

两个插件的 `catch` 现在都会打 `warn`（`file-fast-tune` / `file-fast-restrict`），
不再无声无息。

### 4. 校验器自身的漏洞（也修了）

`verify.mjs` 最初遇到 `cordis:group` 直接 `continue`，导致 compaction 组里的
3 个插件包**从来没被校验过**。现在递归进 group，子行照样查包存在性、键名、必填项。
同样做过反向测试：把子行改成不存在的包名，会准确报出来。

## 出问题时

先跑静态校验，不需要重启 DSH：

```powershell
cd D:\DeepSeek-Workspace\file-fast-preset
node verify.mjs
```

它会模拟 Loader 激活预设时的检查：YAML 能否解析、每行的 `Config` 是不是合法
StandardSchemaV1、引用的包在打包 asar 里是否存在（**含 group 子行**）、
行级 config 的键名和必填项对不对。

**这个脚本做过反向测试**——把历史上那几处 bug 放回去，它都会准确报出来。不是空转的绿灯。

按顺序排查「预设不出现」：

1. `node verify.mjs` —— 预设本身有没有坏
2. `profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有没有 `@local/dsh-file-fast-preset`
3. `dependencies` 里有没有同名 link、`node_modules/@local/` 下软链是否存在
4. 重启 DSH（JS 模块要重新加载）。已有内容的会话改不了预设，必须新开空白会话。

其余常见现象：

- 工具少了想要的 → 改 `restrict.js` 的 `KEEP` 集合，重新安装。
- 觉得还是慢 → 先看日志里有没有 `file-fast-tune` 的 warn（模型不支持 low，或能力查询失败），
  再考虑把 persona 里的"不要长时间思考"写得更硬。
- 觉得回答太简略 → 调 persona 最后「输出」那一段。
