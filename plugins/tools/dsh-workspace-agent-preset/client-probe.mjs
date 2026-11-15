/**
 * Client-half probe: loads lib/client.js in a bare JS sandbox with a minimal
 * React stand-in, renders the settings section, and exercises the two pickers.
 *
 * Not a browser test — it proves the component tree, the catalog wiring, the
 * request bodies, and the degradation paths. Visual layout still needs a page.
 */
import { readFileSync } from 'node:fs'

let failures = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

// ---- minimal React -------------------------------------------------------
// A tiny reconciler: function components get their own persistent hook slots
// keyed by tree position, effects honour their dependency arrays, and state
// updates trigger a re-render. Enough to drive the real component tree.
const instances = new Map()
let current = null
let dirty = false

const sameDeps = (left, right) =>
  Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

const react = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
    return { type, props: props ?? {}, children: flat }
  },
  useState(initial) {
    const holder = current
    const index = holder.cursor++
    if (!(index in holder.state)) holder.state[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(holder.state[index]) : next
      if (Object.is(value, holder.state[index])) return
      holder.state[index] = value
      dirty = true
    }
    return [holder.state[index], set]
  },
  useEffect(fn, deps) {
    const holder = current
    const index = holder.cursor++
    const slot = holder.effects[index]
    if (slot !== undefined && deps !== undefined && sameDeps(slot.deps, deps)) return
    holder.effects[index] = { deps, fn }
  },
  useRef(value) {
    const holder = current
    const index = holder.cursor++
    if (!(index in holder.state)) holder.state[index] = { current: value }
    return holder.state[index]
  },
  useCallback(fn, deps) {
    const holder = current
    const index = holder.cursor++
    const slot = holder.state[index]
    if (slot !== undefined && deps !== undefined && sameDeps(slot.deps, deps)) return slot.fn
    holder.state[index] = { deps, fn }
    return fn
  },
}

function instanceFor(key) {
  let holder = instances.get(key)
  if (holder === undefined) {
    holder = { state: [], effects: [], cursor: 0 }
    instances.set(key, holder)
  }
  return holder
}

function renderNode(node, path) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}/${index}`))
  const { type, props, children } = node
  if (typeof type === 'function') {
    const key = `${path}#${type.name || 'anonymous'}`
    const holder = instanceFor(key)
    const outer = current
    current = holder
    holder.cursor = 0
    let output
    try {
      output = type(props)
    } finally {
      current = outer
    }
    return renderNode(output, key)
  }
  return { type, props, children: children.map((child, index) => renderNode(child, `${path}/${index}`)) }
}

/** Render, flush pending effects, and settle state updates until stable. */
async function mount(component, props, rounds = 12) {
  let tree
  for (let round = 0; round < rounds; round++) {
    dirty = false
    tree = renderNode({ type: component, props, children: [] }, 'root')
    const pending = []
    for (const holder of instances.values()) pending.push(...holder.effects.filter(Boolean))
    for (const holder of instances.values()) holder.effects = holder.effects.map((slot) => (slot === undefined ? slot : { ...slot, fn: undefined }))
    for (const slot of pending) if (slot.fn !== undefined) slot.fn()
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (!dirty && round > 2) break
  }
  return tree
}

// ---- sandbox -------------------------------------------------------------
const STATE = {
  ok: true,
  enabled: true,
  active: true,
  presets: [
    { id: 'standard', name: 'Standard', description: '', broken: null, isDefault: true },
    { id: 'fast-solver', name: 'Fast solver', description: '', broken: null, isDefault: false },
    { id: 'file-fast', name: 'File fast', description: '', broken: 'missing row', isDefault: false },
  ],
  defaultPresetId: 'standard',
  models: {
    default: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    groups: [
      {
        id: 'workbuddy',
        name: 'WorkBuddy',
        models: [
          {
            id: 'deepseek-v4.1-flash',
            name: 'DeepSeek-V4.1-Flash',
            reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
          },
          { id: 'hy4free', name: 'Hy4', reasoning: null },
        ],
      },
      { id: 'openai-compat', name: 'OpenAI 兼容', models: [{ id: 'gpt-image-2.5', name: 'GPT Image 2.5', reasoning: null }] },
    ],
  },
  workspaces: [
    {
      workspaceId: 'ws-1',
      path: 'D:\\解题模式',
      title: '解题模式',
      sessionCount: 3,
      presetId: 'fast-solver',
      stalePresetId: null,
      selection: null,
      staleSelection: null,
      effectiveSelection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    },
    {
      workspaceId: 'ws-2',
      path: 'D:\\DeepSeek-Workspace',
      title: 'DeepSeek-Workspace',
      sessionCount: 204,
      presetId: null,
      stalePresetId: null,
      selection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' },
      staleSelection: null,
      effectiveSelection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' },
    },
    {
      workspaceId: 'ws-3',
      path: 'E:\\酒馆',
      title: '酒馆',
      sessionCount: 8,
      presetId: null,
      stalePresetId: 'gone',
      selection: null,
      staleSelection: { provider: 'workbuddy', model: 'retired-model' },
      effectiveSelection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    },
  ],
  storeFile: 'D:\\DeepSeek-DSH\\workspace-agent-preset\\assignments.json',
  injection: { state: 'ok', workspace: 'D:\\DeepSeek-Workspace', asked: 'standard', got: 'standard', at: 'now' },
  modelInjection: { state: 'ok', workspace: 'D:\\DeepSeek-Workspace', asked: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }, got: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }, at: 'now' },
}

const requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url, init })
  if (url.endsWith('.state')) return { ok: true, status: 200, json: async () => structuredClone(STATE) }
  const body = JSON.parse(init.body)
  const next = structuredClone(STATE)
  const row = next.workspaces.find((entry) => entry.path === body.path)
  if (Object.hasOwn(body, 'selection')) row.selection = body.selection
  if (Object.hasOwn(body, 'presetId')) row.presetId = body.presetId
  return { ok: true, status: 200, json: async () => next }
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild() {} },
}

let registered
const dictionaries = {}
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {} },
    bind: (ns) => (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
  },
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, renderer) => { registered = { options, renderer }; return () => {} },
  },
}

globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      const module = { exports: {} }
      Object.assign(module.exports, factory((name) => (name === 'react' ? react : undefined)))
      ctx.exports = module.exports
    },
  },
}
new Function('window', readFileSync('lib/client.js', 'utf8'))(globalThis.window)
ctx.exports.apply(ctx)

// ---- tree helpers --------------------------------------------------------
function* walk(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

const { renderer } = registered
const t = ctx.locale.bind("workspace-agent-preset")
const tree = await mount(renderer, { t })
const nodes = [...walk(tree)]
const byClass = (name) =>
  nodes.filter((node) => typeof node.props.className === "string" && node.props.className.split(" ").includes(name))
const rowNode = (index) => byClass("wap_row")[index]
const rowSelects = (index) => [...walk(rowNode(index))].filter((node) => node.type === "select")
const allSelects = nodes.filter((node) => node.type === "select")

console.log("--- structure ---")
check("the section registers under settings.section at order 60", () => {
  if (registered.options.name !== "settings.section") throw new Error("wrong slot")
  if (registered.options.id !== "workspace-agent-preset") throw new Error("wrong id")
  if (registered.options.order !== 60) throw new Error("wrong order")
})

check("one card per workspace", () => {
  if (byClass("wap_row").length !== STATE.workspaces.length) {
    throw new Error(`expected ${STATE.workspaces.length} cards, got ${byClass("wap_row").length}`)
  }
})

check("a reasoning row appears only for a workspace with a pinned effort", () => {
  const counts = [0, 1, 2].map((index) => rowSelects(index).length)
  // ws-1: preset + model (nothing stored yet). ws-2: preset + model + effort.
  // ws-3: preset + model (its stored model is stale, so no effort to show).
  if (counts.join(",") !== "2,3,2") throw new Error(`unexpected select counts: ${counts}`)
  if (allSelects.length !== 7) throw new Error(`expected 7 selects, got ${allSelects.length}`)
})

check("the preset select offers the global default plus every roster entry", () => {
  const options = rowSelects(0)[0].children
  if (options[0].props.value !== "") throw new Error("missing follow-global option")
  if (options.length !== STATE.presets.length + 1) throw new Error(`expected ${STATE.presets.length + 1} options, got ${options.length}`)
  if (!JSON.stringify(options[3]).includes("broken")) throw new Error("a broken preset is not marked")
})

check("the model select groups models by provider", () => {
  const groups = rowSelects(0)[1].children.filter((child) => child.type === "optgroup")
  if (groups.length !== 2) throw new Error(`expected 2 optgroups, got ${groups.length}`)
  if (groups[0].props.label !== "WorkBuddy") throw new Error("wrong group label")
  const values = groups.flatMap((group) => group.children.map((option) => option.props.value))
  if (!values.includes("workbuddy\u0000deepseek-v4.1-flash")) throw new Error("missing workbuddy model value")
  if (!values.includes("openai-compat\u0000gpt-image-2.5")) throw new Error("missing openai-compat model value")
})

check("the pinned workspace shows its effort and every level the model offers", () => {
  const effort = rowSelects(1)[2]
  if (effort.props.value !== "low") throw new Error(`expected effort low, got ${effort.props.value}`)
  const ids = effort.children.slice(1).map((option) => option.props.value)
  if (ids.join(",") !== "low,high,max") throw new Error(`wrong efforts: ${ids}`)
  if (effort.children[0].props.value !== "") throw new Error('missing the "model default" option')
})

check("an unset workspace selects the global default and shows its preset", () => {
  if (rowSelects(0)[1].props.value !== "") throw new Error("model select should be empty when unset")
  if (rowSelects(0)[0].props.value !== "fast-solver") throw new Error("preset select should show the assignment")
})

check("the effective line names the model and marks the global default", () => {
  const text = JSON.stringify([...walk(rowNode(0))])
  if (!text.includes("DeepSeek-V4.1-Flash")) throw new Error(`effective model missing: ${text.slice(0, 400)}`)
  if (!text.includes('"default"')) throw new Error("default badge missing")
})

check("a stale selection and a stale preset are flagged, not hidden", () => {
  const text = JSON.stringify([...walk(rowNode(2))])
  if (!text.includes("presetMissing")) throw new Error("stale preset marker missing")
  if (!text.includes("modelMissing")) throw new Error("stale model marker missing")
  if (!text.includes("retired-model")) throw new Error("the stale model id is not shown")
})

check("both self-check lines render when they passed", () => {
  const text = JSON.stringify(nodes)
  if (!text.includes("verifyOk")) throw new Error("preset self-check missing")
  if (!text.includes("modelVerifyOk")) throw new Error("model self-check missing")
})

console.log("\n--- picking ---")
const pick = async (node, value) => {
  if (node === undefined) throw new Error("the expected select is not rendered")
  requests.length = 0
  node.props.onChange({ target: { value } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const sent = requests.at(-1)
  if (sent === undefined) throw new Error("nothing was posted")
  return JSON.parse(sent.init.body)
}

await check("picking an effort-less model posts provider and model only", async () => {
  const body = await pick(rowSelects(0)[1], "openai-compat\u0000gpt-image-2.5")
  if (body.path !== "D:\\解题模式") throw new Error(`wrong path: ${body.path}`)
  if (JSON.stringify(body.selection) !== JSON.stringify({ provider: "openai-compat", model: "gpt-image-2.5" })) {
    throw new Error(`wrong selection: ${JSON.stringify(body.selection)}`)
  }
  if (Object.hasOwn(body, "presetId")) throw new Error("a model change must not touch the preset")
})

await check("picking a reasoning model seeds its adapter default effort", async () => {
  const body = await pick(rowSelects(0)[1], "workbuddy\u0000deepseek-v4.1-flash")
  if (body.selection.reasoningEffort !== "high") throw new Error(`expected default high, got ${JSON.stringify(body.selection)}`)
})

await check("changing only the reasoning level keeps the route", async () => {
  const body = await pick(rowSelects(1)[2], "max")
  if (body.selection.provider !== "workbuddy" || body.selection.model !== "deepseek-v4.1-flash") throw new Error("route changed")
  if (body.selection.reasoningEffort !== "max") throw new Error("effort not sent")
  if (Object.hasOwn(body, "presetId")) throw new Error("a level change must not touch the preset")
})

await check('choosing the model default drops the effort but keeps the route', async () => {
  const body = await pick(rowSelects(1)[2], "")
  if (Object.hasOwn(body.selection, "reasoningEffort")) throw new Error("effort should be omitted")
  if (body.selection.model !== "deepseek-v4.1-flash") throw new Error("route lost")
})

await check("clearing the preset sends presetId null alone", async () => {
  const body = await pick(rowSelects(1)[0], "")
  if (body.presetId !== null) throw new Error("presetId must be null")
  if (Object.hasOwn(body, "selection")) throw new Error("a preset change must not touch the model")
})

await check("clearing the model sends selection null alone", async () => {
  const body = await pick(rowSelects(1)[1], "")
  if (body.selection !== null) throw new Error("selection must be null")
  if (Object.hasOwn(body, "presetId")) throw new Error("a model change must not touch the preset")
})

console.log("\n--- failure paths ---")
await check("a rejected save surfaces the server message", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) =>
    url.endsWith(".assign")
      ? { ok: false, status: 404, json: async () => ({ error: { code: "workspace-agent-preset/unknown-model", message: "Unknown model: x/y" } }) }
      : originalFetch(url, init)
  try {
    const node = rowSelects(0)[1]
    node.props.onChange({ target: { value: "workbuddy\u0000hy4free" } })
    await new Promise((resolve) => setTimeout(resolve, 15))
    const tree2 = await mount(renderer, { t })
    const text = JSON.stringify([...walk(tree2)])
    if (!text.includes("Unknown model")) throw new Error(`error not surfaced: ${text.slice(0, 300)}`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check("both dictionaries cover every key the section uses", async () => {
  const dicts = dictionaries["workspace-agent-preset"]
  const zh = Object.keys(dicts.zh).sort().join(",")
  const en = Object.keys(dicts.en).sort().join(",")
  if (zh !== en) throw new Error("zh and en diverge")
  for (const key of ["modelLabel", "effortLabel", "effortDefault", "modelMissing", "modelVerifyOk", "modelVerifyIgnored", "modelVerifyUntested"]) {
    if (dicts.zh[key] === undefined) throw new Error(`zh is missing ${key}`)
    if (dicts.en[key] === undefined) throw new Error(`en is missing ${key}`)
  }
})

console.log(failures === 0 ? "\nall client checks passed" : `\n${failures} client check(s) failed`)
if (failures !== 0) process.exitCode = 1
