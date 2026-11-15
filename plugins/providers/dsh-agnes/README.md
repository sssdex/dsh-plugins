# dsh-agnes

把 **Agnes AI 的多模态能力**（生图 + 生视频）接进 DeepSeek Harness 的宿主插件。
零依赖，只用 Node 内置模块 + `@deepseek-ai/dsh-tools`。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `agnes_image` | 文生图 / 图生图 / 多图合成。可用 `reference_images` 传原图（URL、本地路径、data URI），生成的图会**作为图片块回给模型看**，同时落盘 |
| `agnes_video` | 生视频，三种模式：`text`（纯提示词）、`keyframe`（`first_frame`/`last_frame` 首尾帧）、`reference`（`images`/`audios`/`videos` 参考素材）。默认等到出结果，等不完就返回 `video_id` |
| `agnes_video_status` | 查任务进度；`wait=true` 可原地轮询到结束，完成后顺手把 mp4 下下来 |

产物默认落在**会话工作目录的 `agnes-out/`** 下（`output_dir` 可改）。

## 配置 API key（四选一，优先级从高到低）

1. `cordis.patch.yml` 里 `dsh-agnes` 的 `config.apiKey`
2. 环境变量 `AGNES_API_KEY`
3. 插件目录里的 `agnes.config.json` ← **推荐**（不写进 patch，patch 可以随便分享）
4. `$DSH_HOME/agnes.config.json` 或 `$DSH_PROFILE_DIR/agnes.config.json`

配置文件格式：

```json
{
  "apiKey": "sk-替换成你的key",
  "baseUrl": "https://apihub.agnes-ai.com/v1",
  "outputDir": "agnes-out",
  "imageModel": "agnes-image-2.5-flash",
  "videoModel": "agnes-video-2.5"
}
```

## 安装

插件目录必须是 `file:` 依赖装进某个 profile：

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": { "dsh-agnes": "link:D:\\DeepSeek-Workspace\\dsh-agnes" },
  "dsh": { "profile": { "bundles": [ /* ...其他 bundle... */, "dsh-agnes" ] } }
}
```

然后在 profile 目录里装依赖：

```powershell
cd $env:DSH_HOME\profiles\desktop
node "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" install
```

`link:` 会让 pnpm 建一个**目录联接（junction）**指回工作区，之后改代码不用再复制；
早期用的 `file:` 会按 `files` 字段复制一份，改完源码得跑 `node tools\sync.mjs` 同步进 node_modules。

> ⚠️ **宿主插件改完必须重启 DeepSeek Harness 才生效**。profile 的 patch 改动能被 HMR 热应用（新插件能热挂载），
> 但 HMR 默认 `root: []` 只监听配置文件、忽略 node_modules，**已加载的模块不会重新 import**——
> 所以热改代码在运行中的宿主里不会生效，重启才会读到最新文件。

## 诊断日志

插件会在自己目录下写 `out/.diagnostics.log`：每次 `apply()` 挂载 + 每次 `agnes_image` 的返回值键清单
（`<undefined>` 会标出来 —— 宿主要求工具返回值是 lossless JSON，`undefined` 一律拒收，
报错就是 `returned invalid output: value is not lossless JSON`）。排查先看这个文件。

## Agnes API 速查（本插件已封好，出错时来这查）

- Base：`https://apihub.agnes-ai.com/v1`，认证 `Authorization: Bearer <KEY>`
- 生图 `POST /images/generations`：`model`（`agnes-image-2.0/2.1/2.5-flash`）、`prompt`、`size`、`image[]`；`response_format` **必须放 `extra_body` 里**，图生图的图 `extra_body.image` 和顶层 `image` 实测都生效
- 生视频 `POST /videos`：`model`（`agnes-video-2.5` / `-flash`）、`prompt`、`mode`、`seconds`（`"4"`~`"12"`）、`size`（`720P|1080P|1K|2K`）、`aspect_ratio`、`seed`
  - `keyframe` 用 `first_frame`/`last_frame`；`reference` 用 `images`/`audios`/`videos`，提示词里用 `<Picture 1>`/`<Audio 1>`/`<Video 1>` 指代
  - 禁用参数（传了 400）：`video_url`、`video_path`、`input_reference`、`width`、`height`、`fps`、`num_frames`、`quality`、`num_inference_steps`
  - `-flash` 只支持 `720P`、图片 ≤5、音频 ≤3、不支持参考视频
- 查任务：`GET https://apihub.agnes-ai.com/agnesapi?video_id=<ID>&model_name=<模型>`，轮询到 `completed`，顶层 `url` 就是 mp4
- 排队满会返回 `503 video_queue_full` —— 插件内置指数退避重试（约 2 分钟窗口）

## 排障

| 症状 | 原因 / 处理 |
| --- | --- |
| `401 Invalid token` | key 不对或过期；检查 `agnes.config.json` 里的 key 是否完整（一个字符都不能少） |
| `503 video queue is full` | 视频队列满，插件会自动退避重试；持续失败就等一会儿再发 |
| 工具没出现 | profile 的 `dependencies` 和 `dsh.profile.bundles` 是否都加了 `dsh-agnes`，pnpm install 是否成功，DSH 是否重启过 |
| 图片块没有回给模型 | 附件服务拒收（尺寸/格式超限）时会静默跳过，文件仍然落盘 |

本地自测（不依赖 DSH 宿主）：

```powershell
cd D:\DeepSeek-Workspace\dsh-agnes
node --import ./tools/_register-stub.mjs tools/smoke.mjs image
```
---

## 关于 npm 同名包

npm 上有一个 `dsh-agnes`（维护者 qlzhj03，仓库 chaoliu615/dsh-agnes），**与本目录不是同一份代码**。
本目录版本按本机工作流实现：产物落会话工作目录的 `agnes-out/`、配置优先级四选一、
`agnes.config.json` 推荐放在插件目录以便 patch 可随意分享、内置 503 队列满的指数退避重试。

`agents-out/` 与 `out/.diagnostics.log` 是运行产物，不进版本库。
