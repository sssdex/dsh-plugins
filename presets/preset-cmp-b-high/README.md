# preset-cmp-b-high

`preset-cmp-b` 的**高推理**变体 —— 纯 YAML 预设，不含插件代码。

## 与 preset-cmp-b 的唯一差别

```yaml
reasoningEffort: low    # preset-cmp-b
reasoningEffort: high   # 本版
```

其余 `cordis.patch.yml` 内容一致（约 9.6KB，仅差 36 字符就是这一处）。
适配 deepseek-v4.1-flash 的 `supportedEfforts: low/high/max`。

## 什么时候用

需要模型多花时间推理、可接受更慢更贵的场景。日常对话用 `preset-cmp-b`（low）即可。

## 文件

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | 预设主体 |
| `restrict.js` | 工具/能力约束 |
| `tune.js` | 参数调优 |

> 本版没有单独的 `README.md` 与 `verify.mjs` —— 前者就是本文件，后者见 `preset-cmp-b`。
