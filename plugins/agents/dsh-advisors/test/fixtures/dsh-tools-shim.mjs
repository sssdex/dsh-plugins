/**
 * 测试替身：`@deepseek-ai/dsh-tools` 的 `defineTool`。
 *
 * 真实实现位于 Electron 的 app.asar 内，普通 node 无法读取；而它的职责是
 * 「把作者的 schema DSL 编译成 JSON Schema，并在 execute 前校验参数」——
 * 那不是本插件的被测对象。这里只保留本插件依赖的那部分契约：
 * 名称与 execute 必须存在，定义原样返回（附加 buildTask 用得到的字段不受影响）。
 */
export function defineTool(options) {
  if (typeof options?.name !== 'string' || options.name === '') throw new Error('defineTool: name required')
  if (typeof options.execute !== 'function') throw new Error('defineTool: execute required')
  if (options.parameters === undefined) throw new Error('defineTool: parameters required')
  if (options.output?.schema === undefined) throw new Error('defineTool: output.schema required')
  return options
}
