/**
 * 让测试能解析 `@deepseek-ai/dsh-tools`：把它重定向到本目录的替身。
 *
 * 真实包在 Electron 的 app.asar 里，普通 node 读不到；测试只关心本插件的行为，
 * 不需要 defineTool 的 schema 编译与参数校验。
 */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const shim = pathToFileURL(path.join(here, 'fixtures', 'dsh-tools-shim.mjs')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: shim, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
