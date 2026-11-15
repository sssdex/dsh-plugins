/**
 * resolve 钩子：把 @deepseek-ai/dsh-tools 指到本地 shim。
 * 由 shim-loader.mjs 通过 register() 挂载。
 */
const SHIM = new URL('./fixtures/dsh-tools-shim.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: SHIM, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
