# dsh-qq-hands · QQ 之手

给 DeepSeek Harness 的助手装上「QQ 里的手和嘴」：主动发消息、发表情包、发语音、发电脑截图、发文件，
并把回复按句拆成多条气泡慢慢发——像真人在连发，而不是甩一大段。

## 它解决什么

| 能力 | 表现 |
| --- | --- |
| 主动触达 | 不用主人先说话也能发消息（主动消息，单聊 1000 条/天） |
| 表情包 | 中文关键词从本机 dsh-meme 图库挑图，如「生气」「得意」「干饭」 |
| 语音 | Edge 神经网络少女音（晓伊），mp3→PCM→SILK，本机不需要 ffmpeg |
| 截图 | 截当前电脑屏幕（可裁剪、可多显示器、可延时），直接发到 QQ |
| 文件 | ≤5MB 直传，更大自动分片，单文件上限 200MB |
| 像真人 | 一条回复按句子拆成 1~3 条气泡，中间 0.55~1.45 秒停顿 |

## 工具

注册在宿主里，任何会话（网页 Chat 或 QQ 会话）都能调用：

- `qq_send_text` —— 发文字。`text`、`chat`、`mode`、`burst`、`markdown`、`wakeup`、`maxBubbles`
- `qq_send_image` —— 发图/表情包。`path` / `url` / `meme`（+`tag`）、`caption`
- `qq_send_voice` —— 发语音。`text`（TTS）或 `path`（已有音频）、`voice`、`engine`、`rate`、`volume`
- `qq_screenshot` —— 截屏发送。`region`、`display`、`delayMs`、`format`、`maxWidth`、`savePath`
- `qq_send_file` —— 发文件。`path`、`name`
- `qq_status` —— 查状态（绑定、token、被动额度、语音引擎、表情库、统计）

通用参数：`chat` = `dm`（默认，主人私聊）或 `group:<群openid>`；`mode` = `auto`（默认）/`passive`/`active`。

## 语音音色

默认 **晓伊（zh-CN-XiaoyiNeural，少女活泼）**，可用 id：

`xiaoyi`（默认）/ `xiaoyi_sweet`（更软更甜）/ `xiaoxiao`（温柔）/ `xiaoxiao_soft`（轻声撒娇）/
`xiaobei`（东北）/ `xiaoni`（陕北）/ `yunxia`（少年音）

`engine`：`auto`（默认，Edge 优先、失败回落 SAPI）/ `edge`（强制神经网络音）/ `sapi`（强制本地老引擎）。
显式传 `voice: "Microsoft Huihui Desktop"` 这类 SAPI 名字时，会自动走 SAPI——尊重点名。

## 依赖与环境

- **Python + edge-tts**（语音）：走本机 `D:\DeepSeek-DSH\dsh-runtimes\...\python\python.exe`。
  装法：`<python> -m pip install edge-tts`。版本 7.3.1 实测可用。
  原因：Edge 接口现在要 v2 版 DRM 令牌（`<16 位 CS64>-<64 位 SHA256>`），手写复刻风险大，借 Python 实现最稳。
- **silk-wasm / mpg123-decoder / ws**：插件目录自带 npm 依赖，不需要在 profile 里装。
- **ffmpeg**：只在转换 mp3/m4a/ogg/flac 音频文件时才需要。
  PATH 里没有时会自动找 `D:\弹弹play\ffmpeg\ffmpeg.exe`、`C:\ffmpeg\bin\ffmpeg.exe` 等常见位置。
- **网络**：Edge 语音需要能连 `speech.platform.bing.com`；断网时自动回落 SAPI，不会没声音。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（都有默认值）：

```yaml
- id: dsh-qq-hands
  config:
    burst: true        # false = 关闭「按句拆多条」
    maxBubbles: 3      # 单条回复最多拆几条（单聊被动回复平台上限 4 条，留余量）
    minGapMs: 550      # 气泡间最短停顿
    maxGapMs: 1450     # 气泡间最长停顿
    accountId: qq_554ceb4b0cad   # 多账号时指定用哪个
```

密钥不重复存：直接复用 IM Connect 已配好的 QQ 账号
（`DSH_HOME/dsh-im-connect/channels.json` 的 appId/openid + DSH credentials 里的 appSecret）。

## 工作原理（两个关键点）

1. **主动 vs 被动**：被动回复（带 `msg_id`）单聊 60 分钟窗口、每条用户消息最多回 4 次；
   主动消息不需要凭据，单聊 1000 条/用户/天。插件自动选：有新鲜凭据就省配额走被动，否则走主动。
   `msg_id` 是从拦截到的 IM Connect 回复里顺手记下来的。
2. **按句拆气泡**：`lib/intercept.js` 拦全局 `fetch`，只拦
   `POST https://api.sgroup.qq.com/v2/{users|groups}/{id}/messages` 的文字消息，
   就地拆句、逐条发、接管 `msg_seq`（平台规则：同一 `msg_id + msg_seq` 重复发送会失败）。
   富媒体消息原样放行，只校正 seq。卸载插件即完全还原。

## 排障

- 「发送失败 / 主动消息被拒绝」：主人可能在 QQ 客户端关了「允许主动发送」；
  或先用 `mode: passive` 等主人发一句话。
- 「没有可用的被动回复凭据」：主人 60 分钟内没发过消息，改用 `mode: active`。
- 语音还是老声音：`qq_status` 看「语音引擎」一行；Edge 不可用会显示原因。
- 表情搜不到：`qq_status` 看表情库分类列表，或直接传 `path` 指定图片。

## 自测

```bash
node --test test-core.mjs    # 状态账本 / QQ 客户端 / 拦截器 / 表情库 12 项
node --test test-burst.mjs   # 分句拆气泡 24 项
node --test test-media.mjs   # TTS / SILK / 截屏 13 项
node e2e.mjs                 # 真发消息到 QQ（文字/表情包/语音/截图/文件）
node voice-samples.mjs       # 音色试听
```
