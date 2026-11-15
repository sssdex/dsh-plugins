# 精简·lean —— 纯 YAML 的保守版 standard 预设

> DSH 0.2.2-rc.1 · profile `desktop` · 目标：**保留全部高频工具，只砍「0 次或极低频 + schema 大」的行**，
> 把提速指望放在 persona 的动作纪律上。**不含任何插件代码，全部是 YAML。**
>
> ⚠️ 本目录只交文件，**没有跑过任何真实会话**。下文所有 token 数字要么来自既有实测数据（标明出处），
> 要么来自本次静态测量（附脚本口径）。未经验证的推断都写在「七、我不确定的地方」。

---

## 一、它到底改了什么

相对 `standard` 的完整差异，一共 **3 类、6 处**：

| # | 类型 | 内容 |
|---|---|---|
| 1 | **删 5 个行** | `tool-schedule`、`workflow-ptc`、`tool-workflow`、`tool-subagent-fork`、`tool-plugin-market` |
| 2 | **改 2 个 config** | `persona` → `complete: true` + `includeRuntimeContext: false` + 全套动作纪律 prefix<br>`tool-skill` → `catalogDescriptionMaxLength: 500 → 200` |
| 3 | **其余 20 行原样保留** | 含 `agent-instructions`、`time-context`、`plan-mode`、`compaction`（阈值一字未动）、`tool-goal`、`plugin_manager` |

顶层行数 22 → 20（standard 是 22 个插件条目，其中 3 个是 `cordis:group` 组）。
`config.id: lean`、`name: 精简·lean`、`order: 21`。

---

## 二、决策表：每个删掉的行，理由 + 省多少

字节数取 **234 份真实 `standard` `request/header` 逐工具 JSON 字节数的均值**（脚本见第五节）。
换算用 **4.04 字符/token**（源自 87 个冷首请求回归）。

### 2.1 删掉的

| 行 id | 包 | 挂的工具 | 均值字节 | ≈tok | 实测调用 | 删的理由 |
|---|---|---|---|---|---|---|
| `tool-schedule` | `dsh-tool-schedule` | `schedule_create/update/edit/list/view/delete` | 5,008 | **1,240** | **11** | 每步频率 0.0004。6 个工具的 schema 是 standard 里第三贵的一块，几乎从不使用。要定时任务时切回 standard 即可。 |
| `tool-workflow` | `dsh-tool-workflow` | `workflow` | 3,259 | **807** | **0** | 全机 25,750 步里**一次都没被调用过**，却是单条第二贵的 schema（描述里带整段「何时用」的强提示，反而诱导模型走多 agent 编排）。 |
| `tool-subagent-fork` | `dsh-tool-subagent`(fork) | `subagent_fork` | 1,139 | **282** | **0** | 0 次调用；`subagent`（spawn）已保留，派生能力不缺。 |
| `workflow-ptc` | `dsh-workflow-ptc` | （无，只给 workflow 供后端） | 0 | **0** | — | 单独留着会让 `workflow` 工具报错，与 `tool-workflow` 必须同进退。 |
| `tool-plugin-market` | `dsh-plugin-market/tools` | `plugin_market` | 0（`disabled: true`） | **0** | **0** | standard 里本来就是 `disabled: true`、实测出现率 0%。删行纯粹让清单干净，**省不到 token**。 |

**删除合计：8 个实际出现在 header 里的工具 + `plugin_market`（出现率 0%，删了省 0 tok）
= 9,406 字节 / ≈ 2,329 tok**（占 header 9.2%）。
逐工具四舍五入后再相加得 2,329；9,406 ÷ 4.04 = 2,328.2，两种口径差 1 tok，属舍入。

### 2.2 保留的（以及为什么不出手）

| 行 id | 工具 | ≈tok | 实测调用 | 留的理由 |
|---|---|---|---|---|
| `tool-pwsh` | `pwsh` | **834** | **13,599** | 全机最高频（每步 0.53）。删了这预设就没有执行力。 |
| `tool-fs` | `read/write/edit/read_image` | 662 | 8,027 | 第二高频（每步 0.313）。一个都不动。 |
| `tool-fs-search` | `glob/grep` | 346 | 1,094 | 每步 0.043；删了只能靠 pwsh 搜，通常更慢。 |
| `tool-jobs` | `job_list/output/kill` | 272 | 315 | `job_output` 是 `async_parse_pdf` 等后台任务的唯一收口，删了长任务无法取结果。 |
| `tool-ask-user` | `ask_user_question` | 308 | 144 | 在用的澄清通道；删了歧义时只能猜。 |
| `present` | `present` | 200 | 94 | 交付物卡片，白送的能力。 |
| `tool-todo` | `todo_write` | 202 | 121 | 多步任务需要它；本预设 persona 明确「状态交给 todo_write」。 |
| `tool-web` | `web_search/web_fetch` | 135 | 961 | 极便宜却是主力，绝无删的道理。 |
| `tool-skill` | `skill` | 79 | 60 | 只 79 tok，却决定 office/pdf 技能能不能被路由到。 |
| `tool-plugin-manager` | `plugin_manager` | 191 | **94** | 调用数比 `subagent` 还多。保留它 = 装卸插件不必为了切回 standard 另开对话。 |
| `tool-goal` + `command-goal` | `create/get/update_goal` | 408 | 6 | **刻意保守**：`dsh-goal` 服务与 `goal-round-driver` 在**宿主平面**，预设删不掉。只删工具会留下「已存在的 goal 被自动续跑、而模型读不到也改不了」的死结。省 408 tok 不值得冒这个风险。 |
| `plan-mode`（`planning` 组） | `exit_plan_mode` | 79 | **0** | **刻意保守**：该行在 `dsh-web-app/cordis.patch.yml` L536 被 `disabled: true`（Web 面的计划模式由预设拥有）。`exit_plan_mode` 是渐进披露的，未激活时根本不在工具表里，实测只摊到 79 tok。删掉换不到有意义 token，却可能让 Web 端计划模式开关指向不存在的服务。 |
| `subagent` | `subagent` | 400 | 27 | 唯一能把大块上下文甩出去的入口。 |
| `tool-subagent-control` | `list_agents/send_message/interrupt_agent` | — | — | Agent Teams 与 subagent 续跑都要用；standard 也这么搭。 |
| `agent-instructions` | （AGENTS.md 链） | 458 | — | 本机 `$DSH_HOME/AGENTS.md` 写着识图走原生视觉、PDF 走 mineru、斗图规则等踩坑经验。删它是性价比最差的一刀。 |
| `time-context` | （每步时间读数） | 71/次 | — | 判断「今天/本周」要靠它，删了收益可忽略。 |
| `compaction` 组 | — | — | — | **阈值一字未动**。`tool-result-pruner` 用 `surfaceOp: replace` 顶掉旧节点，一改阈值就从被改写那条起 KV cache 全废，省下的 prefill 远不够赔。 |

---

## 三、header 会从多少降到多少

**口径**：234 份真实 `standard` 会话的 `request/header`，逐工具 `JSON.stringify` 字节数取均值。
`≈tok = 字节 / 4.04`。

| | 工具数 | 字节 | ≈tok |
|---|---|---|---|
| `standard` 实测均值 | 95.9 | 102,635 | **25,405** |
| **`lean` 估算** | **≈ 90.4** | **93,229** | **≈ 23,076** |
| 差 | **−5.6** | −9,406 | **−2,328** |

> **工具数只能减约 5.6 个，不是 9 个** —— 因为删掉的 9 个工具名在各份 header 里的**出现率不同**：
> `workflow` 96%、`schedule_create` 93%、`schedule_update`/`schedule_delete` 65%、
> `schedule_list` 93%、`schedule_edit`/`schedule_view` 28%、`subagent_fork` 96%、
> `plugin_market` **0%**（standard 里本来就 `disabled: true`，省 0 tok）。
> 按出现率加权后，每份 header 实际少 **5.64** 个工具。
> **注意口径**：这 9 个工具的 token 是按「在出现过的 header 里的实际字节」算的，
> 所以 −2,328 tok 成立；减 5.6 个工具是「均值工具数」口径，两者不矛盾。

> **为什么只降 9.2%**：这 96 个工具里只有 26 个是预设挂的（≈6,453 tok），另外 70 个是宿主/三方插件挂的
> （≈18,946 tok，74.6% 碰不到）。纯 YAML 删行的天花板就在这里。
> 已验证的例子：`fast-solver` 预设只声明了 persona、**一行工具都没有**，header 仍然有 84 个工具 / 109,143 B。

### 提示词侧的另外三刀（不删工具）

| 旋钮 | 省 | 依据 |
|---|---|---|
| `persona.complete: true` | **≈2,190 tok** | standard system prompt 8,363 字符；只剩 prefix 后大幅缩短 |
| `persona.includeRuntimeContext: false` | **≈824 tok** | 运行时快照实测 3,047 字符 |
| `tool-skill.catalogDescriptionMaxLength: 500→200` | **≈666 tok** | 本机 34 条技能目录实测 9,026→6,337 字符（见 4.1） |
| **小计** | **≈3,680 tok** | |

### 合计

```
单请求 prefill 变化 ≈ −2,328（schema）−3,680（提示词）= −6,008 tok
折算冷请求（94.95 ms/1k tok）：≈ 0.57 秒
折算热请求（12.80 ms/1k tok，r²=0.014）：≈ 0.08 秒
```

> **说人话：这点收益在 100 秒量级的轮次里是噪声。**
> 真正的收益只能来自「少跑一步往返」（中位 6.3 秒）和「压思考长尾」（思考占生成 token 66.5%）。
> 这就是为什么本预设把 persona 写成动作纪律，而不是继续抠工具。

---

## 四、两个 config 调的取舍

### 4.1 `catalogDescriptionMaxLength: 200`（不是 80）

本机 34 条技能目录逐条实测截断后体积：

| maxLength | 目录字符 | ≈tok | 相对 500 省 |
|---|---|---|---|
| 500（默认） | 9,026 | 2,234 | — |
| 300 | 8,190 | 2,027 | 207 |
| **200** | **6,337** | **1,569** | **666** |
| 160 | 5,457 | 1,351 | 884 |
| 120 | 4,491 | 1,112 | 1,123 |
| 80 | 3,446 | 853 | 1,381 |
| 40 | 2,172 | 538 | 1,697 |

**为什么停在 200**：技能目录不只占 token，它的主要职责是**让模型知道何时该加载哪个技能**。
实测 34 条里，描述中「Use when…」这个触发语出现在第 200 字符之后的就有 6 条
（`archify` 在 #399、`ppt-master` #228、`threejs-asset-pipeline` #219、`threejs-fundamentals` #186…）；
压到 80 则会把 **16 条**的触发语砍掉。多省 700 tok（≈0.07 秒冷 TTFT）换技能误路由，不划算。

> 若主人认为技能路由无所谓、只想极致瘦身，改 `200 → 80` 即可，省 1,381 tok。

### 4.2 `persona.complete: true` 的代价（必须知道）

`complete: true` 会让 system prompt **只剩本预设写的那段**。DSH 自带的
「身份段 / 后缀 / 工具引导段 / listener」全部不再追加。也就是说下面这些**原本白送**的东西没了：

- `[exit code: N]` 是标记不是失败 的说明
- `@path` 表示用户显式指定的文件 的说明
- read-before-edit、prefer read/edit/write over shell 的引导
- 模型名 / 运行时上下文里的图像工具默认 provider、订阅参数约束、canvas 状态

所以 `cordis.patch.yml` 里的 prefix **自己把工具规则写全了**，不是只写「你要简短」。
**这是本预设最大的质量风险点**：静态校验能保证「YAML 合法、包存在、键名正确」，但
**保证不了模型真的会照这段 prefix 干活** —— 那必须靠实跑对比。

> 组合陷阱（已在 prefix 里规避）：只设 `includeRuntimeContext: false` 而**不**设 `complete: true`，
> 系统提示里会留下指向「它永远看不到的值」的段落（asar 第 2225837 行警告）。两者必须成对。

---

## 五、怎么装、怎么验

### 5.1 静态自检（可以立刻做）

```powershell
cd D:\DeepSeek-Workspace\preset-cmp-a
node verify.mjs
```

校验内容：
1. YAML 能解析（含 `!!js` 标量）
2. 声明行合法；`config.id` 不与 `standard/minimal/ptc/cordis` 撞名
3. 每个 `name` 的包在 **asar 或 profile node_modules** 里存在；
   带子路径的（`@deepseek-ai/dsh-plugin-manager/tools`）还要 `package.json exports` 里真有该子路径
4. 行级 config 键名存在于该插件的 `Config`；`.required()` 字段不漏
   （也覆盖 `dsh-plan-mode` 这种**没有 zod Config、用 `resolveConfig()` 手写校验**的包）
5. persona 专项：`complete: true` 时 `prefix` 必填；且不得出现被实测否定的措辞
6. 与 standard 的差集 + header 估算

### 5.2 安装（由 Lead 执行，本目录不碰 profile）

```powershell
# 1) 挂进 profile（这会改 profiles/desktop/package.json 的 dependencies + bundles）
#    注意：本目录没有权限也不需要自己装。
# 2) 注册进 preset 列表需要 profile 的 cordis.patch.yml 有一行声明，
#    或者让 bundle 自带 patch（本包 dsh.bundle.patch 已指向 cordis.patch.yml，
#    安装为 bundle 后由 loader 读取）。
# 3) 重启 DSH，然后在【空白会话】的下拉框里选「精简·lean」。
```

> 已存在的会话沿用创建时的组合（`agentPresetProjectionDefinition.init = header.agentPreset ?? null`），
> **改完必须新开对话才生效**。

### 5.3 端到端验收（Lead 的统一测试，不能只看「感觉快了」）

按 `slim-standard-verdict.md` 第七节的口径：

- 同批次任务在 **standard / lean 各跑 ≥6 对**（fast-mode 记过同配置单跑差三成）
- 比 **墙钟 + 步数 + 思考字符**，不是比「感觉」
- 重点看：persona 纪律有没有真的减少**步数**（少 1 步 = 6.3 秒，比省 token 值钱得多）
- 反例警戒：官方 `minimal` 工具更少，但思考字符 2,419/步 > standard 的 2,014、步/轮 59.2 > 30.7。
  **少工具 ≠ 少思考**，所以本预设的成败主要看 prefix 而不是看删行。

---

## 六、已知边界（不是 bug，是设计边界）

1. **只能碰 25.4% 的工具 schema。** 宿主/三方插件挂的 70 个工具（≈18,946 tok）纯 YAML 动不了。
   想碰它们必须写代码插件调 `ctx.tools.restrict()`，而本版**明确不做**。
2. **速度收益量级很小。** schema −2,328 tok、提示词 −3,680 tok，合计约 0.57 秒/冷请求、
   0.08 秒/热步。真正的钱在步数和思考长尾。
3. **`reasoningEffort` 改不了。** 它在 `profiles/desktop/cordis.patch.yml` 第 9 行，
   而且 `dsh-agent` 的 `prepareRequest` 在 `agent/request` 里改 effort 会直接抛错。
   预设层无处声明它（`PresetDefinition` 只有 5 个字段）。**本预设不改变思考长度。**
4. **`complete: true` 丢了 DSH 自带工具引导**，全部靠 prefix 自补。这是质量风险，只能实跑验证。
5. **技能目录仍有 12 条来自宿主平面**（office 系列、official-plugins、browser-skill 等），
   它们走 `ctx.skills.registerProvider`，与 `skill-filesystem` 无关，预设层裁不掉。
6. **只在空白会话的下拉框可选**；老会话不会自动切换。

---

## 七、我不确定的地方（如实说）

| # | 不确定项 | 为什么不确定 | 影响 |
|---|---|---|---|
| 1 | **`workflow-ptc` 删掉会不会连累其他行** | `@deepseek-ai/dsh-tool-ralph` 的 `static inject` 里有 `workflowEngine`。本机 profile 的 `package.json` bundles 里**没有** ralph（`ralph in profile bundles: false`），profile patch 里也没有 ralph 行，所以按现状不该触发。但若有别的 bundle 间接挂了 ralph，它会因服务缺失而注入失败。 | 中。装完若启动报 `workflowEngine` 相关错误，把 `delegation` 组的 `workflowEngine: true` 隔离与 `workflow-ptc` 行加回即可。 |
| 2 | **`persona.complete: true` 后模型是否遵守** | 静态校验只能确认 prefix 是合法字符串、不含被否定的措辞。**它有没有减少步数、有没有把答案写全，必须实跑才知道。** | 高。这是本预设的核心假设。 |
| 3 | **`plan-mode` 留着到底值不值** | 我按「Web 面由预设拥有 + 渐进披露成本 79 tok + 删了可能让 UI 开关悬空」选择保留。但 `exit_plan_mode` 实测 **0 次调用**，若主人从不用计划模式，这条留着纯属浪费（虽然只浪费 79 tok）。 | 低。 |
| 4 | **`tool-goal` 保留是否过度保守** | 实测仅 6 次调用。我保留是因为 goal 服务在宿主平面会自动续跑。但我**没有实际验证**「预设不挂 tool-goal 时，宿主的 goal-round-driver 会怎么表现」。 | 低-中。若确认无副作用，删掉可再省 408 tok。 |
| 5 | **header 估算的工具数** | 已按各工具**出现率加权**：删掉 9 个工具名，但每份 header 实际只少约 **5.6** 个（`schedule_edit` 只有 28% 的 header 里有、`plugin_market` 0%）。token 降幅 −2,328 是把「出现过的 header 里的实际字节」减掉，与工具数口径无关，量级可信；但**若真实会话恰好都是 `schedule_*` 全出现的那种 header，实际降幅会更大，反之更小**。 | 低。 |
| 6 | **`order: 21` 的位置** | 只影响 UI 排序，不影响任何运行时行为。现有自定义预设 `super-code` 是 5、`file-fast` 6、`fast-solver` 7，取 21 是为了排在内置之后、不干扰既有顺序。 | 无。 |
| 7 | **没有验证过 bundle 安装链路** | 本目录 `package.json` 的 `dsh.bundle.patch` 格式抄自 `fast-solver-preset`（已跑通的样板），但我**没有实际 install 验证**。 | 中。由 Lead 装时确认。 |

---

## 八、文件清单

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 声明，`@local/dsh-preset-lean`，`dsh.bundle.patch → ./cordis.patch.yml` |
| `cordis.patch.yml` | 预设本体：`- insert:` + `id: preset-lean` + `config.id: lean` + 20 个插件行 |
| `verify.mjs` | 静态自检（6 类检查 + 负例可复现） |
| `README.md` | 本文件 |

### 可复现：本文数字是哪来的

| 数字 | 来源 |
|---|---|
| 96 工具 / 102,635 B / 25,405 tok（standard header 均值） | 扫 `D:\DeepSeek-DSH\sessions` 全量 zstd，取 `agentPreset === 'standard'` 且有 `request/header` 的 234 份，逐工具 `JSON.stringify` 字节均值 |
| 逐工具字节（`schedule_create` 2,576 B 等） | 同上，按 `t.name` 聚合 |
| 提示词侧 −2,190 / −824 tok | `anatomy/standard-breakdown.md` 第 3.5 节的实测反解 |
| 技能目录 9,026→6,337 字符 | 取一份真实会话里的 `<available_skills>` 块（9,063 字符 / 34 条），按 `dsh-tool-skill` 的 `catalogDescription()` 逻辑复算截断后体积 |
| 调用频次（13,599 / 8,027 / 11 / 0 …） | `anatomy/tool-usage.json`（320 会话 / 25,750 步 / 30,164 次调用） |
| 冷/热 TTFT 斜率 94.95 / 12.80 ms/1k | `slim-standard-verdict.md` 第三节 |
| `minimal` 反例（思考 2,419/步、步/轮 59.2） | `slim-standard-verdict.md` 第五节 |
| `plan-mode` 在 Web 面被 disabled | asar 内 `dsh-web-app/cordis.patch.yml` L536 |
| `workflowEngine` 的 inject 方 | asar 内扫全部包的 `lib/index.js`：只有 `dsh-tool-ralph`、`dsh-tool-workflow` |
| `agent-instructions` / `time-context` 走 user message 而非 system prompt | 两包 `lib/index.js` 均 import `createUserMessage`，且全文无 `systemPrompt` |
