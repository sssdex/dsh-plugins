# 酒馆双预设（dsh-tavern-preset）

DSH 上的角色扮演预设：**备卡**解析 SillyTavern 角色卡，**扮演**直接成为角色。
不依赖任何第三方插件，解析器零依赖纯 Node。

## 为什么自己写

`dsh-plugin-tavern` 那两个 preset 物化到 `~/.dsh/.agent-presets/` 后不出现——
那条目录路线在当前 launcher 上已废弃（`presets.json` 是空数组），
现行机制是 bundle patch 里声明 `@deepseek-ai/dsh-agent-preset`
（`standard` / `minimal` / `fast-solver` / `sprint` 都是这么做的）。

除此之外，原版设计每轮都要 `write` 一次 chat.jsonl + state.json，一轮至少
两次文件往返。扮演要的是「立刻回话」。本预设：

| | dsh-plugin-tavern | 本预设 |
|---|---|---|
| 注册方式 | 物化到废弃的 `.agent-presets/` 目录 | bundle patch 声明 agent-preset |
| 对话历史 | 每轮写 chat.jsonl | 就是 DSH 会话本身，不落盘 |
| 状态更新 | 每轮 | 大事件 + 每 5 轮 |
| 扮演每轮工具调用 | ≥ 2 次（读到写） | 0 次（常态纯文本） |
| 思考档位 | 不动 | 降到 low（只降不升，查不到能力不动） |
| 工具面 | 宿主平面全开 | restrict 到 6 个，其余全 deny |
| 卡格式 | PNG/JSON，V1/V2/V3 | 同左（自带解析器 `parse-card.cjs`） |

## 装

```powershell
dsh plugin --profile desktop add D:\DeepSeek-Workspace\dsh-tavern-preset
```

已装在 desktop profile 里（`link:` 安装，改源码即生效，重启 DSH 后预设出现）。

## 用

1. 新建会话，预设选 **酒馆·备卡**，说 `解析这张卡 D:\path\card.png`
   → 输出到 `D:\DeepSeek-DSH\tavern\cards\<卡名-哈希>\`，其中 `card.md` 是扮演的唯一事实源。
2. 新建会话，预设选 **酒馆·扮演**，说 `加载 Blanche` 或直接粘贴角色设定。

指令：`换开场` / `查看状态` / `重置` / `换卡` / `出戏`。

## 文件

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | 两个预设的完整声明（persona + 工具面 + 压缩） |
| `restrict.js` | 工具收窄器，`mode: play` 留 6 个 / `mode: prep` 留 12 个 |
| `tune.js` | 推理档位降级器（只降不升） |
| `parse-card.cjs` | 角色卡解析器，零依赖 |
| `sample-card.json` | 测试卡（Blanche，慢热型灯塔守夜人） |

## 解析器

```powershell
node parse-card.cjs <卡文件> [输出根目录]
node parse-card.cjs --selftest        # 4 项自检
```

PNG 走 `tEXt` chunk（`ccv3` 优先，`chara` 次之）→ base64 → UTF-8 JSON；
JSON 卡直接读。V1 扁平 / V2 / V3 归一化成同一结构，世界书按
`constant` 优先 + `insertion_order` 升序拼接。

纯图卡（无元数据）会报错并提示走 `read_image` 视觉兜底——由备卡预设手写 `card.md`。

## 踩坑备忘

- `@deepseek-ai/dsh-persona` 的字段是 `prefix`，老版的 `text` 会报 `$.prefix missing required value`。
- **prefix 里不能写双花括号。** prefix 走 DSH 的 prompt 模板引擎，`{{...}}` 是变量插值，
  只注册了 `provider` / `model`。写别的（比如 `{{user}}`）会让整轮报
  `unknown prompt variable`，直接跑不起来。`card.md` 里可以写——那是文件内容，不过模板引擎。
- 所以 `parse-card.cjs` 生成 card.md 时就把 `{{user}}` / `{{char}}` 换成实际称呼。
  存量卡用 `fix-macros.cjs <cards 目录>` 一次性清理。
- 本包的 `restrict.js` / `tune.js` **不要**导出 `Config`：link 安装拿不到
  `@deepseek-ai/schemastery`，写了会让整个预设报 `.validate` 错误连带挂掉。
- YAML 里 `prefix: |` 块内的缩进必须与父级严格对齐（多一个空格就是
  `bad indentation of a mapping entry`），中文全角字符不影响，但**手动补进块里的行
  容易少一个空格**——改完用 `yaml.parse()` 验一遍。
- `dsh-tool-fs-search` 的 `sampleOverCapGlobResults` 是 required 无默认值。
- restrict 的两道幂等闸（`applying` + `lastDenyKey`）缺一不可：restrict 自身会触发
  `tools/change`，而本插件就在那个事件上重跑 → 无出口微循环 → host 满核空转。

## 运行时宏

`{{user}}` / `{{char}}` 在解析时替换成实际称呼。其他 ST 运行时宏
（`{{date}}`、`{{time}}`、`{{getvar}}`、`{{random}}`、`{{get_message_variable}}` …）
**保留原文**：它们需要 SillyTavern 运行时，静态卡里没有值可填，替换成任何假值都是错的。
解析器会把残留宏列在 `meta.json` 的 `residualMacros` 里并在命令行报告，
让你知道这张卡会在哪打折。扮演时角色按上下文自然处理（问日期就随口说一个合理的）。

