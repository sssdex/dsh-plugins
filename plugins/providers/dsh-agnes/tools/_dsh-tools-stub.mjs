// defineTool 的最小桩：原样返回定义（真实宿主会做校验与注册）
export function defineTool(definition) {
  if (!definition || typeof definition.name !== 'string') throw new Error('defineTool: name 必填')
  if (typeof definition.execute !== 'function') throw new Error('defineTool: execute 必填')
  return definition
}
