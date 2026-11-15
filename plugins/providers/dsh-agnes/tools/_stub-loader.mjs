// 把 '@deepseek-ai/dsh-tools' 重定向到本地桩，方便脱离 DSH 宿主做冒烟测试
export function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./_dsh-tools-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
