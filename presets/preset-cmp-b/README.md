# 冲刺·sprint —— 用代码插件碰宿主那 74.6% 的激进版预设

给 DSH 加一个「少想、少跑、改完就答」的 agent 预设。B 版（激进派）的立场：
**删 YAML 行省不出速度，真正能碰的是 `ctx.tools.restrict()`。**

> 状态：**只做了静态自检，没有跑过真实会话**。下文所有数字分两类，各自标注了来源：
> 【实测】= 从本机 320 个会话日志 / asar 源码读出来的；【推算】= 由实测值换算的估计，有误差。

---

## 一、它解决什么（实测前提）

本机 2026-11-11，DSH 0.2.2-rc.1，profile `desktop`，320 会话 / 25,750 步 / 30,164 次工具调用：

| 事实 | 数值 | 出处 |
|---|---|---|
| 一步往返 | 中位 **6.3 s** / 均值 19.7 s | 【实测】`slim-standard-verdict.md` |
| 一轮步数 | 中位 12 步 / 均值 32.7 步 | 【实测】同上 |
| 时间三分布 | prefill 25.0% / decode 33.8% / **gap（工具+宿主）41.2%** | 【实测】同上 |
| 生成 token 三分 | **思考 66.5%** / 工具参数 30.7% / 可见文字 **2.8%** | 【实测】同上 |
| 思考 >5000 字符的步 | 占 **10.8%**，吃掉 **45.9%** 的 decode | 【实测】同上 |
| standard header | 112 工具 / 138,192 B，逐工具均值求和 **102,610 B ≈ 25,399 tok** | 【实测】本次 n=233 |
| 其中 preset YAML 行能管的 | 26 工具 / 6,448 tok（**25.4%**） | 【实测】同上 |
| 其中宿主/三方插件挂的 | 70 工具 / 18,938 tok（**74.6%**） | 【实测】同上 |

**铁证**：`fast-solver` 预设只声明 persona、一行工具都没有，header 仍是 **84 个工具 / 109,143 B ≈ 27,016 tok**。
删 YAML 行碰不到那 74.6%。

反过来，`file-fast` 用 `ctx.tools.restrict({deny})` 把 header 压到 **24 个工具 / 23,962 B ≈ 5,931 tok**。

### 天花板要说清楚（别自欺）

热请求 TTFT 斜率只有 **12.80 ms/1k tok**（r²=0.014），本机缓存命中率 **96.16%**。
所以砍 20,000 tok 在**热步**上只值 ~0.26 秒 —— 这个收益是**噪声级**。

真正值钱的两处：
1. **冷请求** 94.95 ms/1k（r²=0.502）→ 会话首轮 / 破 cache 那一刻，20,000 tok ≈ **1.9 秒**；
2. **认知面**：70 个用不上的工具不参与选型。少一次「要不用 cg 试试」的往返 = **中位 6.3 秒**。这条无法静态证明。

---

## 二、三层设计

### 第 1 层：persona `complete: true` + `includeRuntimeContext: false`

`dsh-system-prompt` 的 `assemble()` 里：只要有一个 `complete: true` 的 section，装配后
`sections` 就**只剩那一段**（`sections: completeSection === void 0 ? transformed.sections : [completeSection]`）。
DSH 自带的 read-before-write / pwsh 用法 / 工具选型提示**全部消失**。

⚠ 这是本预设最大的风险点：**persona 文本就是它唯一的行为依据**。改它等于改整个 agent 的脑子。
所以 persona 里把「工具怎么用」整套写全了（见第五节）。

`includeRuntimeContext: false` 走的是 `systemPrompt.suppressRuntimeContext()`，去掉每轮运行上下文快照。
注意 `required: true` 的上下文仍会保留 —— 那是「行号 / 工作目录」这类不能丢的东西。

### 第 2 层：`restrict.js` 用 deny 掩码压宿主平面

**为什么用 deny 不用 allow**：`dsh-tools` 的 `ToolLayer.admits()` 是
`allow !== undefined && !allow.has(name) || deny !== undefined && deny.has(name) → false`，
即「所有 filter 都要 admit 才可见」= **取交集**。allow 反复施加会越收越窄；
deny 反复施加是并集，天然可累积、幂等。

**两道幂等闸缺一不可**（2026-11-11 实机死循环事故）：
`ToolsService` 的 `ScopedLayers` 变更回调里写着 `this.ctx.emit("tools/change")`，
而 `restrict()` 正是往 `layer.restrictions` append —— 于是
`restrict → tools/change → restrict` 是无出口的微任务循环，表现为 host 满核空转、两分半后被掐。
- `applying` 布尔：restrict 期间收到 tools/change 直接返回；
- `lastDenyKey` 字符串比对：名单没变就不再 restrict。

只靠其中一个都不够：只靠 `applying`，等异步派发回来时它已落回 false；
只靠 `lastDenyKey`，第一次下发那一瞬间就会重入，此时 key 还没写入。

**取名字用 `view(undefined).knownNames`**（等于全局工具集）而不是 `view(scope).restrictableNames`：
`restrict()` 只接受 `restrictableNames`，多一个名字就整批抛
`tools.restrict() names unknown global tool ...`。而全局工具是任何 scope 的
`restrictableNames` 的子集（`inherited` 从 global 起步），所以取全局视图**永远不会**触发那个拒绝。

### 第 3 层：`tune.js` 在 `agent/created` 降推理档

- 先查 `ctx.llm.resolveModelInfo(provider, model)` 该路由真实支持的 `reasoning.efforts`；
- **不是 `resolveModel`** —— 那是 adapter 内部方法，写成它会一直抛 TypeError 被 catch 吞掉，
  表现为「预设装好了但推理强度从没变过」；
- 查不到能力 / 不支持 → 不动；只降不升。

---

## 三、KEEP 清单（23 个）逐个给依据

字节 = 该工具在 233 个真实 standard `request/header` 里的**序列化字节均值**【实测】。
频次 = 本机 25,657 步 / 30,164 次调用里的**真实调用次数**【实测】。

### 本预设 YAML 行自己挂的（17 个）

| 工具 | 字节 | ≈tok | 调用次数 | 为什么留 |
|---|---:|---:|---:|---|
| `pwsh` | 3,367 | 833 | **13,599** | 占全部调用 45.1%、占工具墙钟 56.1%。schema 最贵，但删了没法干活 |
| `read` | 421 | 104 | 2,632 | 一切编辑的前提；`complete:true` 下没有 read 就没有内容来源 |
| `read_image` | 376 | 93 | 1,896 | 用户级 AGENTS.md 明确要求默认走原生视觉读图 |
| `edit` | 1,077 | 267 | 2,196 | 局部改；比 write 省 token（不用复述全文） |
| `write` | 800 | 198 | 1,303 | 新建文件与整文件重写的唯一途径 |
| `grep` | 675 | 167 | 995 | 按内容找；不开就只能 glob+read 硬扫 |
| `web_fetch` | 234 | 58 | 745 | 58 tok，单位 token 收益最高的工具之一 |
| `job_output` | 589 | 146 | 237 | **`async_parse_pdf` 只返回 job_id，结果必须靠它取回** |
| `web_search` | 314 | 78 | 216 | 同上，极便宜 |
| `ask_user_question` | 1,243 | 308 | 144 | 中位阻塞 27.7 s（在等你，不是在算）。删了模型会用纯文字反问，多跑一步等同一个答案 |
| `todo_write` | 821 | 203 | 121 | 多步任务的进度载体，也是「不写进度汇报」的替代通道 |
| `present` | 808 | 200 | 94 | 交付物分卡展示，web 端主要交付通道 |
| `glob` | 721 | 178 | 99 | 按名找文件；不开无法定位未知路径 |
| `job_kill` | 354 | 88 | 69 | 长任务失控时要能停；没有它模型会去翻进程 |
| `skill` | 318 | 79 | 60 | docx/xlsx/pptx 盲写 OOXML 的失败成本远超 79 tok |
| `job_list` | 161 | 40 | 9 | 便宜的兜底：job_output 拿错 id 时要列清单 |
| `bash` | **0** | **0** | 2 | win32 上不进 header。非 win32 上由 tool-bash 行注册、替代 pwsh。**KEEP 必须与 pwsh 成对写**，否则 linux/mac 上唯一的 shell 会被自己的 deny 掩掉 |

### 祖先层提供、靠 KEEP 放行的（6 个）

| 工具 | 字节 | ≈tok | 调用次数 | 来源 | 为什么留 |
|---|---:|---:|---:|---|---|
| `load_workspace_dependencies` | 632 | 156 | 75 | desktop-office（profile 层） | 拿 python/node 绝对路径。缺了它 pwsh 里 `python` 找不到 → 模型猜路径 → 多跑 2~3 步 |
| `convert_to_markdown` | 653 | 162 | 3 | dsh-markdownize | 频次低但替代成本高（模型会用 python-docx 手搓，慢很多） |
| `read_pdf` | 991 | 245 | 7 | dsh-pdf-mineru | 用户级 AGENTS.md 指定的 PDF 唯一入口 |
| `async_parse_pdf` | 216 | 53 | 3 | dsh-pdf-mineru | 扫描件必须走它（同步版长文档超时） |
| `working_directory` | 205 | 51 | 6 | dsh-base bundle:169 | 51 tok，「cd 到目录」的干净做法 |
| `open_local_file` | 772 | 191 | 11 | dsh-file-launcher | 用户点开文件的通道；191 tok 换一次少走一步 |

**合计 23 个、15,748 B ≈ 3,898 tok**【推算，÷4.04】。

### 入选标准是唯一的，可复现

**频次 > 0**。上面 23 个里最低的是 `bash` 2 次（且那 2 次是在非 Windows 环境），其余全部 ≥ 3 次。
频次为 0 的一律不留 —— 这是这份清单唯一的主观之处为零的地方。

---

## 四、砍掉了什么（省 ≈21,500 tok）

按归属分组，字节来自同一份 233 样本均值【实测】：

| 组 | 工具数 | 字节 | ≈tok | 实测调用 |
|---|---:|---:|---:|---:|
| `ego_*`（桌面操控） | 35 | 14,193 | 3,513 | 1,052 |
| image-gen（`generate_*` / `edit_image` / `workbuddy_draw_*` / `agnes_*` / `doubao_*`） | 8 | 13,311 | 3,295 | 58 |
| team / 委派（`team_task_*`、`agent_teams_*`、`subagent*`、`workflow`、`spawn_teammate` …） | 28 | 12,750 | 3,156 | 291 |
| `compress` / `decompress` / `disk_cleanup` / `automation_*` / `sw_*` / `univer_*` / `blender_*` / `ig5_*` … | 81 | 9,204 | 2,278 | 395 |
| `cg` / `stg` / `lingshu_*`（灵枢） | 4 | 5,704 | 1,412 | 53 |
| `mcp__*`（GitHub / Gitee / Chrome DevTools / 邮箱 …） | 83 | 5,210 | 1,290 | 190 |
| `schedule_*` | 6 | 5,010 | 1,240 | 11 |
| `remote_*` | 11 | 4,011 | 993 | 1 |
| meme / chat（`send_meme` / `learn_meme` / `meme_*`） | 4 | 3,359 | 831 | 64 |
| browser（`bsk_*` / `see_now` / `sidebar_open` / `view_canvas`） | 10 | 3,353 | 830 | 69 |
| `session_*` / `search_context` / `acp_*` | 9 | 2,715 | 672 | 39 |
| `plugin_manager` / `plugin_market` / `find_dsh_plugins` / `create_skill` | 4 | 2,305 | 571 | 136 |
| goal / plan-mode（`create_goal` / `get_goal` / `update_goal` / `exit_plan_mode`） | 4 | 1,978 | 490 | 6 |
| `mcp_connector_*` / `mcp_search_tools` … | 30 | 1,875 | 464 | 60 |
| 其余零散（`find_inspiration` / `list_subagent_models` / `send_wechat` / `qq_*` …） | 17 | 1,890 | 468 | 32 |
| **合计** | **334 个名字** | **86,868** | **≈21,502** | |

> 「334 个名字」是 233 个样本里出现过的、不在 KEEP 里的 union ——比单个 header 里实际的
> 70 个宿主工具多，因为不同会话装/卸的插件不同。

**YAML 行层面也刻意没挂**（不照抄 standard 的 22 行）：
`tool-schedule`（1,978 tok / 11 次）、`tool-goal` + `command-goal`（428 tok / 6 次）、
`planning` 组即 plan-mode（117 tok / **0 次**）、`delegation` 组即 subagent/subagent_fork/
workflow-ptc/tool-workflow（843+315 tok / **0 次**）、`tool-plugin-manager`（662 tok / 94 次）、
`tool-plugin-market`（358 tok / **0 次**）。

---

## 五、预估 header（推算，不是实测）

两个口径都给，因为第二个才是现实值：

| 口径 | 工具数 | 字节 | ≈tok | 对比 25,400 |
|---|---:|---:|---:|---|
| A：只算 KEEP | 23 | 15,748 | 3,898 | −84.7% |
| **B：现实值** | **31** | **20,547** | **5,086** | **−80.0%** |

**B 比 A 多的 9 个工具（4,799 B ≈ 1,188 tok）是 preset 层永远挡不掉的**，理由见第六节。
file-fast 的实测值是 24 工具 / 5,931 tok —— 本预设 31 个工具 / 5,086 tok，
工具更多但 tok 更少，因为砍掉了 file-fast 还留着的 `todo_write`(203) 之外那些工具中较胖的，
且没有让它漏进来 `cg`。

**折成墙钟【推算】**：
- 冷请求首轮：20,314 tok × 94.95 ms/1k ≈ **1.93 秒**
- 热步：20,314 × 12.80 ms/1k ≈ **0.26 秒/步**（≈ prefill 中位 2,775 ms 的 9%，噪声级）

对比：少跑一步往返 = **6.3 秒**。所以这个预设真正的卖点在 persona 那层，不在 token 那层。

---

## 六、已知边界（如实说）

### 1. 有 9 个工具 preset 层永远挡不掉（硬边界）

`dsh-experimental-tool-agent-team` 的 `apply()` 在有 Team 成员的 agent 上，
用 **agent 自己的 scope** 注册工具：

```js
const maybeInstall = (agent) => { … install(agent, ctx, resolved) };   // install 里用 agent.ctx
ctx.on("agent/created", ({ agent }) => { maybeInstall(agent) });
```

而 `dsh-tools` 的 `view()` 注释写得很明确：
> Restrictions intersect over inherited global and ancestor tools; **the viewing scope's own registrations remain exempt**.

所以这 9 个永久占 **4,799 B ≈ 1,188 tok**：
`interrupt_agent` `list_agents` `send_message` `spawn_teammate`
`team_task_create` `team_task_get` `team_task_list` `team_task_update` `wait_agent`

**证据**：`fast-solver`（零工具行）和 `file-fast`（deny 到 24 工具）的实测 header 里，
这 9 个**同时都在**。file-fast 的 deny 名单本来也会覆盖它们，但没生效。

**唯一的解法**是把 profile `package.json` 的 `dsh.profile.bundles` 里
`@deepseek-ai/dsh-experimental-agent-team-profile` 那行去掉 —— 那属于改 profile，
不在本次任务的允许范围内（硬边界 1），**留给 Lead 决定**。

### 2. `complete: true` 的代价

DSH 自带的**全部**提示段失效，包括工具引导、plan-mode 指引、Team 政策、各类工具用法说明。
persona 是它唯一的行为依据。另外 persona 必须自己写全「先读再改」「长命令走后台」这类规则，
否则模型没有依据。

### 3. `catalogDescriptionMaxLength: 120` 是有损的

技能目录里每条描述截断到 120 字符（默认 500）。技能**正文**不受影响（`skill` 工具返回全文），
但纯靠目录描述判断「该不该调这个技能」的准确率会降。
本机技能多（37 个），实测这一刀约省 900+ tok/轮【推算】—— 我**没有单独测过**这个值。

### 4. tune.js 的收益置信度低

档位中位思考字符：`max` 552 / `high` 363 / `low` **506** —— **不单调**。
`low` 的中位比 `high` 还高。真正的差别在尾部（`max` 的 p90 更肥），
而本机 profile 现在已经是 `high`（`deepseek-v4.1-flash` 的 `supportedEfforts: low/high/max`）。
所以 `config.reasoningEffort: low` 到底是不是净收益，**我不知道**。
想保守就把 YAML 里那行改成 `high`（等于维持现状、插件什么都不做）。

### 5. 没做端到端

**我没有跑过任何真实会话。** 所有「会更快」的判断都是把实测数据往这个配置上套的推算。
验收口径建议（verdict 里给的）：同批次任务 standard / sprint 各跑 ≥6 对，
比 **墙钟 + 步数 + 思考字符**，不能只看感觉（fast-mode 记过同配置单跑差三成）。

### 6. 其他

- 只在**空白会话**的下拉框可选，已有内容的会话改不了。
- 预设不是沙箱：preset 的 YAML 和 JS 能执行 Host 代码。
- `pwsh` 占工具墙钟 56.1%（中位 1,750 ms / p90 11,244 ms），这部分 preset 影响不了 ——
  只能靠 persona 的「长命令走后台 / 批量用脚本」去提示，实际取决于任务。

---

## 七、文件与用法

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 声明（`@local/dsh-preset-sprint`），`dsh.bundle.patch` 指向 YAML |
| `cordis.patch.yml` | 预设声明：persona + 15 个顶层行 + compaction 组 |
| `restrict.js` | 工具收窄器（deny 掩码，两道幂等闸，失败安全） |
| `tune.js` | 推理强度降档（先查能力再设，只降不升） |
| `verify.mjs` | 静态自检（54 项，含 group 子行递归 + 反向测试） |
| `_evidence/` | 本次推导用的只读脚本与数据（`_header_budget.json` 是 verify 的字节来源） |

### 静态自检

```powershell
cd D:\DeepSeek-Workspace\preset-cmp-b
node verify.mjs            # 54 项
node _evidence\_negative_test.mjs   # 14 个历史 bug 复现，验证校验器不是空转
```

### 安装（Lead 做，我没做）

1. 把 `@local/dsh-preset-sprint` 加进 profile `package.json` 的 `dependencies`（`link:D:/DeepSeek-Workspace/preset-cmp-b`）
   和 `dsh.profile.bundles`；
2. `plugin_manager` `install_bundle`；
3. **重启 DSH**（JS 模块要重新加载代次）；已有内容的会话改不了预设，必须新开空白会话；
4. 新建会话，下拉框选 **冲刺·sprint**。

想设成默认：profile `cordis.patch.yml` 的 `agent-preset-registry` 里 `selectedDefault: sprint`。

---

## 八、本次设计里我改过的两个判断

**1. `restrict.js` 的取名字方式从 `knownNames` 保持原样，但注释写清了为什么。**
一开始我打算改成 `view(scope).restrictableNames`（语义上更精确），
读源码后发现 preset 层拿不到 scope key（`scopeOf(ctx)` 需要 `kScope` 符号，没导出；
`ctx` 上也没有 scope getter），`view(undefined)` 反而是唯一安全且不会触发
`names unknown global tool` 的选择。file-fast 的写法是对的，我加了论证。

**2. 没有把 `run_code` 写进 KEEP。**
它必须从 deny 里剔除（`restrict()` 会 throw），但**不该**写进 KEEP ——
它的可见性归 PTC executor 管，写进 KEEP 只会让日志误以为我们在放行它。
`RESERVED` 单独一个集合，语义分开。
