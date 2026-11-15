# preset-cmp-b10

`preset-cmp-b` 系列的 `sprint10` 变体 —— 纯 YAML 预设，不含插件代码。

## 与 preset-cmp-b 的差别

`cordis.patch.yml` 约 9.5KB（`preset-cmp-b` 为 9.6KB），差异集中在工具编排与轮次约束部分。
`reasoningEffort` 与 `preset-cmp-b` 相同，都是 `low`。

带 `verify.mjs`（27KB），用于校验预设结构与轮次行为。

## 文件

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | 预设主体 |
| `restrict.js` | 工具/能力约束 |
| `tune.js` | 参数调优 |
| `verify.mjs` | 结构校验脚本 |

> 这一版是从 `preset-cmp-b` 派生的实验分支，保留在仓库里作为对照。
> 生产使用建议以 `preset-cmp-b` 或 `preset-cmp-b-high` 为准。
