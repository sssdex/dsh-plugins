# dsh-thinking-guard

把被第三方中转（或模型自己）塞进**正文**里的 `<thinking>…</thinking>` 还原成 `reasoning` 块，
让「思考」回到思考面板，而不是当成最终答案糊在主人脸上。

## 症状

用中转站的 DeepSeek 时，回答里直接出现大段英文/中文的推理过程，前后带 `<thinking>` 标签：

- `session-00ab7fdc`（2026-10-02）：`"<thinking>Now write the reply — 一句话接茬 + 图 + 简短延伸。</thinking>  [表情: …]  哦——"`
- `session-80e80327`：17 次命中
- `session-38ec47ab`、`session-adf11a5e`、`session-b78bd715`（官方通道 + `reasoningEffort:high` 也中招）……

65 个会话里 **14 个**中招，且**间歇性**——同一个模型同一分钟，有时思考走 `reasoning` 通道（正常），
有时被写进 `content` 里（泄漏）。

## 根因

- DeepSeek 官方协议是**分离**的：思考走 `delta.reasoning_content`，正文走 `delta.content`。
- DSH 的 pi-ai 适配层只认这些字段名（`reasoning_content` / `reasoning` / `reasoning_text`），
  **认不出正文里的 `<thinking>` 标签** → 于是它成为一个普通 `text` 块 → 渲染成「最终答案」。
- `@deepseek-ai` 全家桶里字面量 `<thinking>` 只出现在 pi-ai 的 README（描述旧行为），
  实现里已经没有；也没有任何提示词教模型用这个标签。所以标签是**模型/中转侧**自己产生的。

## 修法

挂 `llm/stream` waterfall（签名：`(options, next) => AsyncIterable<StreamChunk>`），
在流式层把 text 通道按标签切成两条通道：

```
上游:  block-start{0,text}  text-delta{0,"<thinking>推理"}  text-delta{0,"</thinking>正文"}  block-end{0,{text}}
下游:  block-start{0,reasoning} reasoning-delta{0,"推理"} block-end{0,…}
       block-start{N,text}      text-delta{N,"正文"}      block-end{N,…}
```

细节：

- **分片安全**：标签可能被 SSE 切碎，透传时永远多留 `len(tag)-1` 个字符做缓冲。
- **开标签前的空白**：确认是思考后丢掉，避免产出一个只有空白的 `text` 块。
- **标签没闭合就断流**：整段按 `reasoning` 处理 —— 数据不丢，只是不算正文。
- **不碰其他通道**：`reasoning-delta`、`tool-call-delta`、`usage`、`finish` 原样透传。
- **异常兜底**：`makeStream` 抛错就返回原始流；迭代中抛错先冲刷再抛，绝不吞内容。
- **`mode: 'strip'`**：直接丢掉思考段，正文更干净（不要思考就选它）。

## 配置

`cordis.patch.yml` 里给插件传参即可（不传用默认）：

```yaml
- insert:
    - id: dsh-thinking-guard
      name: dsh-thinking-guard
      config:
        enabled: true        # false = 完全停用
        openTag: '<thinking>'
        closeTag: '</thinking>'
        mode: reasoning      # reasoning | strip
```

环境变量 `DSH_THINKING_GUARD=0` 也能一键停用（排查用）。

## 自测

```bash
node selftest.mjs      # 10/10 passed
```

自测里自带一个「与 DSH `BlockAssembler` 同语义」的迷你汇编器（index 首次出现决定类型、
`block-end` 携带最终块、顺序按首次出现），断言 `<thinking>` 绝不出现在 `text` 块里。

## 已知影响

块数量变化会让 pi-ai 的 `replayState.blocks` 对不齐，DSH 会把 `replay` 置为 `undefined`
（`assembler.js` 的 `assembled()` 显式支持）。代价是这一轮的思考签名不再回放给提供方 ——
对治这个毛病反而更好。
---

## 关于 npm 同名包

npm 上有一个 `dsh-thinking-guard`（维护者 yan3raa，仓库 YAN3RA/dsh-thinking-guard），**与本目录不是同一份代码**。
本目录版本挂的是 `llm/stream` waterfall，带分片安全缓冲（多留 `len(tag)-1` 字符）、
未闭合标签按 reasoning 处理、`mode: strip` 可选丢弃，以及 `DSH_THINKING_GUARD=0` 一键停用。

## 维护提示

在流式层按标签切分通道，前提是 DSH 的 pi-ai 适配层不认正文里的 `<thinking>`（现状如此）。
如果上游以后原生支持了，这个插件就该退役。
