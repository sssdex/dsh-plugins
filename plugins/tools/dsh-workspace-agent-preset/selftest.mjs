/**
 * Self-test for the Host half. Run with `node selftest.mjs`.
 *
 * Exercises the pure pieces (path keys, store durability, request decoration,
 * selection normalization) and the two injection seams against a temporary
 * `DSH_HOME`, so it never touches the live assignment file.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'wap-selftest-'))
process.env.DSH_HOME = home

const mod = await import('./lib/index.js')
const { apply, pathKey, storeFile, overrideMethod, normalizeSelection, selectionLabel, recordedSelection } = mod

let failures = 0
const test = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

console.log(`store file: ${storeFile()}`)

test('pathKey rejects empty and relative-free nonsense', () => {
  assert.equal(pathKey(''), undefined)
  assert.equal(pathKey(undefined), undefined)
  assert.equal(pathKey('x'.repeat(5000)), undefined)
})

test('pathKey canonicalizes and case-folds on Windows', () => {
  const dir = join(home, 'Some Project')
  mkdirSync(dir, { recursive: true })
  const key = pathKey(dir)
  assert.equal(typeof key, 'string')
  if (process.platform === 'win32') assert.equal(key, pathKey(dir.toUpperCase()))
})

test('normalizeSelection keeps a complete route and drops garbage', () => {
  assert.deepEqual(normalizeSelection({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }), {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
  })
  assert.deepEqual(normalizeSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }), {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  })
  assert.equal(normalizeSelection({ provider: 'p' }), undefined)
  assert.equal(normalizeSelection({ provider: '', model: 'm' }), undefined)
  assert.equal(normalizeSelection(null), undefined)
  assert.equal(normalizeSelection('workbuddy/x'), undefined)
  assert.equal(normalizeSelection({ provider: 'p', model: 'bad\nid' }), undefined)
  assert.equal(selectionLabel({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(selectionLabel({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m · high')
  assert.equal(selectionLabel(undefined), '(none)')
})

test('recordedSelection reads the projection seam before the durable log', () => {
  const fromProjection = recordedSelection({
    model: { recordedSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }) },
    session: { snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'x', model: 'y' } }] },
  })
  assert.deepEqual(fromProjection, { provider: 'p', model: 'm', reasoningEffort: 'high' })

  const fromLog = recordedSelection({
    model: {},
    session: {
      snapshotEvents: () => [
        { type: 'model/selection', data: { provider: 'old', model: 'a' } },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'model/selection', data: { provider: 'new', model: 'b', reasoningEffort: 'low' } },
      ],
    },
  })
  assert.deepEqual(fromLog, { provider: 'new', model: 'b', reasoningEffort: 'low' })

  // An empty projection answer means "nothing recorded", not "read the log".
  assert.equal(recordedSelection({ model: { recordedSelection: () => null }, session: { snapshotEvents: () => [] } }), undefined)
  assert.equal(recordedSelection({ model: {}, session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] } }), undefined)
  assert.equal(recordedSelection(undefined), undefined)
  assert.equal(recordedSelection({ model: { recordedSelection: () => { throw new Error('x') } } }), undefined)
})

test('overrideMethod installs, restores, and refuses overridden installs', () => {
  class Sample {
    greet(value) {
      return `orig:${value}`
    }
  }
  const sample = new Sample()
  const dispose = overrideMethod(sample, 'greet', (original) => (value) => `wrapped:${original.call(this, value)}`)
  assert.equal(sample.greet('a'), 'wrapped:orig:a')
  const inner = overrideMethod(sample, 'greet', () => () => 'second')
  assert.equal(sample.greet('a'), 'second')
  inner()
  assert.equal(sample.greet('a'), 'wrapped:orig:a')
  dispose()
  assert.equal(sample.greet('a'), 'orig:a')
  assert.equal(Object.hasOwn(sample, 'greet'), false)
})

console.log('\n--- plugin behaviour ---')

const MODELS = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    models: [
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek-V4.1-Flash',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      },
      { id: 'hy4free', name: 'Hy4', reasoning: null },
    ],
  },
  { id: 'openai-compat', name: 'OpenAI 兼容', models: [{ id: 'gpt-image-2.5', name: 'GPT Image 2.5', reasoning: null }] },
]

/** Build a fake Cordis-ish context with the services the plugin reads. */
function fakeContext({ assignments, presets = ['standard', 'fast-solver'], workspaces = [] } = {}) {
  const presetsService = {
    list: async () =>
      presets.map((id) => ({ id, name: id.toUpperCase(), description: '', order: 0 })),
    resolve: async () => ({ id: presets[0] }),
  }
  const workspaceService = {
    list: () => workspaces.map((w) => ({ id: w.id, path: w.path, title: w.title ?? w.path, sessionIds: w.sessionIds ?? [] })),
    get: (id) => workspaceService.list().find((w) => w.id === id),
  }
  const calls = []
  /** Live Agents, keyed by session id, with the model seam the wrapper touches. */
  const agents = new Map()
  let counter = 0
  const controller = {
    async create(request) {
      calls.push(request)
      if (request?.sessionId === 'fail') throw new Error('boom')
      const sessionId = request?.sessionId ?? `s${++counter}`
      // Reuse mirrors the real controller: a named blank Session keeps its Agent.
      let agent = agents.get(sessionId)
      if (agent === undefined) {
        agent = {
          id: sessionId,
          current: undefined,
          model: {
            select(selection) {
              agent.current = { ...selection }
            },
            current() {
              return agent.current
            },
          },
        }
        agents.set(sessionId, agent)
      }
      return { sessionId, agentPreset: request?.agentPreset }
    },
    async modelCatalog() {
      return { default: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }, groups: MODELS, failures: [] }
    },
  }
  const llm = {
    async resolveCallConfig(config) {
      const model = MODELS.find((group) => group.id === config.provider)?.models.find((m) => m.id === config.model)
      if (model === undefined) throw new Error(`unknown model ${config.provider}/${config.model}`)
      const efforts = model.reasoning?.efforts ?? []
      if (config.reasoningEffort !== undefined && !efforts.some((effort) => effort.id === config.reasoningEffort)) {
        throw new Error(`unsupported reasoning effort ${config.reasoningEffort}`)
      }
      return config
    },
  }
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    get(name) {
      if (name === 'agentPresets') return presetsService
      if (name === 'workspaceRegistry') return workspaceService
      if (name === 'sessionController') return controller
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'llm') return llm
      return undefined
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
  const config = { enabled: true, log: false }
  const dispose = apply(ctx, config)
  return { ctx, controller, calls, routes, dispose, workspaceService, presetsService, agents }
}

const workspaceDir = join(home, 'proj-a')
const otherDir = join(home, 'proj-b')
mkdirSync(workspaceDir, { recursive: true })
mkdirSync(otherDir, { recursive: true })
mkdirSync(join(home, 'workspace-agent-preset'), { recursive: true })
writeFileSync(
  storeFile(),
  JSON.stringify(
    {
      version: 2,
      assignments: {
        [pathKey(otherDir)]: { presetId: 'standard', model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' } },
      },
    },
    null,
    2,
  ),
)

const harness = fakeContext({ workspaces: [{ id: 'ws-1', path: workspaceDir }] })

const stateRoute = harness.routes.get('/api/workspace-agent-preset.state')
const assignRoute = harness.routes.get('/api/workspace-agent-preset.assign')
assert.ok(stateRoute, 'state route registered')
assert.ok(assignRoute, 'assign route registered')

// let the roster warm
await new Promise((resolve) => setTimeout(resolve, 30))

const post = (body) =>
  assignRoute.fetch(
    new Request('http://localhost/api/workspace-agent-preset.assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

let stateResponse = await stateRoute.fetch(new Request('http://localhost/api/workspace-agent-preset.state'))
let stateBody = await stateResponse.json()
assert.equal(stateResponse.status, 200)
assert.equal(stateBody.workspaces.length, 1)
assert.equal(stateBody.workspaces[0].presetId, null)
assert.deepEqual(stateBody.models.groups.map((group) => group.id), ['workbuddy', 'openai-compat'])
assert.equal(stateBody.workspaces[0].effectiveSelection.model, 'deepseek-v4.1-flash')
console.log('  ok   state route reports the catalog and the global default model')

await harness.controller.create({ workspaceId: 'ws-1' })
assert.equal(harness.calls.at(-1).agentPreset, undefined)
console.log('  ok   an unconfigured workspace keeps the platform defaults')

// ---- preset assignment ---------------------------------------------------
{
  const response = await post({ path: workspaceDir, presetId: 'fast-solver' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.workspaces[0].presetId, 'fast-solver')
  const first = await harness.controller.create({ workspaceId: 'ws-1' })
  assert.equal(harness.calls.at(-1).agentPreset, 'fast-solver')
  assert.equal(harness.agents.get(first.sessionId).current, undefined)
  console.log('  ok   a preset assignment applies, and carries no model')
}

// ---- model assignment ----------------------------------------------------
{
  const selection = { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }
  const response = await post({ path: workspaceDir, selection })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.workspaces[0].selection, selection)
  const created = await harness.controller.create({ workspaceId: 'ws-1' })
  assert.equal(harness.calls.at(-1).agentPreset, 'fast-solver')
  const agent = harness.agents.get(created.sessionId)
  assert.deepEqual(agent.current, selection)
  const after = await (await stateRoute.fetch(new Request('http://localhost/api/workspace-agent-preset.state'))).json()
  assert.equal(after.modelInjection.state, 'ok')
  assert.equal(after.modelInjection.asked.model, 'deepseek-v4.1-flash')
  console.log('  ok   a model assignment is recorded on the new Session and self-checked')
}

{
  const row = await harness.routes
    .get('/api/workspace-agent-preset.state')
    .fetch(new Request('http://localhost/api/workspace-agent-preset.state'))
    .then((response) => response.json())
  assert.equal(row.workspaces[0].selection.model, 'deepseek-v4.1-flash')
  const created = await harness.controller.create({ workspaceId: 'ws-1' })
  assert.deepEqual(harness.agents.get(created.sessionId).current, {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'low',
  })
  console.log('  ok   a model assignment survives a state round-trip and is applied')
}

{
  const response = await post({ path: otherDir, selection: { provider: 'workbuddy', model: 'hy4free' } })
  assert.equal(response.status, 200)
  const created = await harness.controller.create({ cwd: otherDir })
  assert.deepEqual(harness.agents.get(created.sessionId).current, { provider: 'workbuddy', model: 'hy4free' })
  console.log('  ok   cwd-only creation applies a model too, and an effort-less model stays effort-less')
}

{
  // The composer lets a model be picked on a blank Session, and `create` reuses
  // that Session. That pick is the person's own choice: it must survive.
  const response = await post({ path: workspaceDir, selection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' } })
  assert.equal(response.status, 200)
  const picked = await harness.controller.create({ workspaceId: 'ws-1', sessionId: 'picked' })
  assert.equal(picked.sessionId, 'picked')
  const agent = harness.agents.get('picked')
  const chosen = { provider: 'openai-compat', model: 'gpt-image-2.5' }
  agent.current = { ...chosen }
  agent.model.recordedSelection = () => ({ ...chosen })
  const reused = await harness.controller.create({ workspaceId: 'ws-1', sessionId: 'picked' })
  assert.equal(reused.sessionId, 'picked')
  assert.deepEqual(agent.current, chosen)
  const state = await harness.routes
    .get('/api/workspace-agent-preset.state')
    .fetch(new Request('http://localhost/api/workspace-agent-preset.state'))
    .then((res) => res.json())
  assert.equal(state.modelInjection.state, 'kept')
  assert.deepEqual(state.modelInjection.got, chosen)
  console.log('  ok   a model already recorded on a reused Session is not overwritten')
}

{
  const before = JSON.parse(readFileSync(storeFile(), 'utf8'))
  const response = await post({ path: workspaceDir, selection: { provider: 'workbuddy', model: 'ghost-model' } })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error.code, 'workspace-agent-preset/unknown-model')
  assert.deepEqual(JSON.parse(readFileSync(storeFile(), 'utf8')), before)
  console.log('  ok   an unlisted model is refused and nothing is written')
}

{
  const response = await post({ path: workspaceDir, selection: { provider: 'workbuddy' } })
  assert.equal(response.status, 400)
  console.log('  ok   a malformed selection is refused')
}

{
  const response = await post({ path: workspaceDir })
  assert.equal(response.status, 400)
  console.log('  ok   a change that names neither field is refused')
}

{
  // Clearing one field must not disturb the other.
  const response = await post({ path: workspaceDir, presetId: null })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.workspaces[0].presetId, null)
  assert.deepEqual(body.workspaces[0].selection, { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' })
  const created = await harness.controller.create({ workspaceId: 'ws-1' })
  assert.equal(harness.calls.at(-1).agentPreset, undefined)
  assert.deepEqual(harness.agents.get(created.sessionId).current.model, 'deepseek-v4.1-flash')
  console.log('  ok   clearing the preset leaves the model in place')
}

{
  const response = await post({ path: workspaceDir, selection: null })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.workspaces[0].selection, null)
  assert.equal(body.workspaces[0].effectiveSelection.model, 'deepseek-v4.1-flash')
  const created = await harness.controller.create({ workspaceId: 'ws-1' })
  assert.equal(harness.agents.get(created.sessionId).current, undefined)
  console.log('  ok   clearing the model falls back to the global default')
}

// ---- explicit choices win ------------------------------------------------
{
  await post({ path: workspaceDir, selection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' } })
  await post({ path: workspaceDir, presetId: 'standard' })
  const created = await harness.controller.create({ workspaceId: 'ws-1', agentPreset: 'standard' })
  assert.equal(harness.calls.at(-1).agentPreset, 'standard')
  assert.deepEqual(harness.agents.get(created.sessionId).current.reasoningEffort, 'low')
  console.log('  ok   an explicit preset is never overridden')
}

// ---- stale values degrade instead of failing ------------------------------
{
  const before = JSON.parse(readFileSync(storeFile(), 'utf8'))
  before.assignments[pathKey(workspaceDir)].model = { provider: 'workbuddy', model: 'retired-model' }
  before.assignments[pathKey(workspaceDir)].presetId = 'gone'
  writeFileSync(storeFile(), JSON.stringify(before), 'utf8')
  const fresh = fakeContext({ workspaces: [{ id: 'ws-1', path: workspaceDir }] })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const body = await (await fresh.routes.get('/api/workspace-agent-preset.state').fetch(new Request('http://localhost/api/workspace-agent-preset.state'))).json()
  assert.equal(body.workspaces[0].presetId, null)
  assert.equal(body.workspaces[0].selection, null)
  assert.equal(body.workspaces[0].staleSelection.model, 'retired-model')
  const created = await fresh.controller.create({ workspaceId: 'ws-1' })
  assert.equal(fresh.calls.at(-1).agentPreset, undefined)
  assert.equal(created.sessionId.length > 0, true)
  assert.equal(fresh.agents.get(created.sessionId).current, undefined)
  console.log('  ok   a stale preset and model degrade to the defaults instead of failing')
}

// ---- version-1 stores still load -----------------------------------------
{
  writeFileSync(storeFile(), JSON.stringify({ version: 1, assignments: { [pathKey(workspaceDir)]: 'standard' } }), 'utf8')
  const legacy = fakeContext({ workspaces: [{ id: 'ws-1', path: workspaceDir }] })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const body = await (await legacy.routes.get('/api/workspace-agent-preset.state').fetch(new Request('http://localhost/api/workspace-agent-preset.state'))).json()
  assert.equal(body.workspaces[0].presetId, 'standard')
  assert.equal(body.workspaces[0].selection, null)
  const created = await legacy.controller.create({ workspaceId: 'ws-1' })
  assert.equal(legacy.calls.at(-1).agentPreset, 'standard')
  assert.equal(legacy.agents.get(created.sessionId).current, undefined)
  console.log('  ok   a version-1 store is still read as preset-only')
}

// ---- durable v2 shape ----------------------------------------------------
{
  await post({ path: workspaceDir, presetId: 'standard' })
  await post({ path: workspaceDir, selection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } })
  const onDisk = JSON.parse(readFileSync(storeFile(), 'utf8'))
  assert.equal(onDisk.version, 2)
  assert.deepEqual(onDisk.assignments[pathKey(workspaceDir)], {
    presetId: 'standard',
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  })
  console.log('  ok   both fields persist together under one version-2 entry')
}

// ---- a failed creation is not swallowed ----------------------------------
{
  const fresh = fakeContext({ workspaces: [{ id: 'ws-1', path: workspaceDir }] })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await assert.rejects(() => fresh.controller.create({ sessionId: 'fail' }), /boom/)
  console.log('  ok   a rejected create still rejects')
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
