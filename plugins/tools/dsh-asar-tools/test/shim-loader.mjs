/**
 * `--import` 入口：注册 resolve 钩子，把 `@deepseek-ai/dsh-tools` 指到本地 shim。
 *
 * 需要重定向的原因：真实包在 app.asar 内，普通 node 解析不到；而它也不是
 * 本插件的被测对象（defineTool 只做形状校验）。
 *
 * 注意：`--import` 只负责执行本文件，钩子必须显式 register()。
 */
import { register } from 'node:module'

register('./resolve-hook.mjs', import.meta.url)
