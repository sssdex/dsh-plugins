/**
 * 测试用 shim：把 `@deepseek-ai/dsh-tools` 的 defineTool 指向真实实现的替身。
 *
 * 真实包在 app.asar 里，普通 import 解析不到；而 defineTool 的职责是
 * 「校验工具定义形状」，不是本插件的被测对象。这里按真实契约做最小校验：
 * name / parameters / output{schema,render} 必须存在。
 */
export function defineTool(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('defineTool: 需要对象')
  if (typeof options.name !== 'string' || options.name === '') throw new TypeError('defineTool: name 必填')
  if (typeof options.execute !== 'function') throw new TypeError('defineTool: execute 必填')
  if (options.parameters === undefined) throw new TypeError('defineTool: parameters 必填')
  const out = options.output
  if (out === undefined || typeof out !== 'object') throw new TypeError('defineTool: output 必填')
  if (out.schema === undefined) throw new TypeError('defineTool: output.schema 必填')
  if (typeof out.render !== 'function') throw new TypeError('defineTool: output.render 必填')
  if (out.presentationMeta !== undefined && typeof out.presentationMeta !== 'function') {
    throw new TypeError('defineTool: output.presentationMeta 必须是函数')
  }
  return options
}
