/**
 * dsh-workspace-agent-preset — Host half.
 *
 * Gives every Workspace its own default Agent preset *and* its own default
 * model (provider + model + reasoning effort).
 *
 * Three moving parts:
 *
 *  1. A durable map from a canonical workspace directory to a workspace
 *     preference — a preset id, a model selection, or both — stored in
 *     `$DSH_HOME/workspace-agent-preset/assignments.json`. The Workspace
 *     registry itself keeps no room for plugin-owned fields, so the map is ours.
 *     Version 1 files (a bare preset id per directory) are still read.
 *
 *  2. A wrapper around `sessionController.create`. The Web client sends
 *     `agentPreset` only when the person picked one explicitly — the new-session
 *     chip passes it, the sidebar "new task" button passes nothing — and an
 *     omitted preset resolves against the global default. The wrapper fills
 *     `agentPreset` from the workspace map *before* that resolution runs, and
 *     never overrides a request that already names one.
 *
 *  3. A post-create model installation. `SessionCreateRequest` has no model
 *     field, so the created Session starts on the global default; the wrapper
 *     awaits the create, resolves its live Agent, and records the workspace
 *     selection through `agent.model.select()`. That is the same durable
 *     `model/selection` event `sessionController.selectModel` writes, minus its
 *     `agentDefaultModel.saveSelection` side effect — a workspace model must
 *     never rewrite the deployment-wide default.
 *
 * Why wrapping the live instance is sound here: the API Gateway resolves the
 * callable with `Reflect.get(callReceiver, descriptor.method)` at invocation
 * time (dsh-api-gateway `prepareInvocation`), so an own-property override on the
 * service object is what gets called. `dsh-mcp-manager` wraps `agents.create` /
 * `agents.resume` the same way, for the same reason.
 *
 * Authenticated Fetch routes on the `/api` channel (the Host/Origin fence and
 * owner-Peer admission are applied by `ctx.connection` before these run):
 *
 *   GET/POST api/workspace-agent-preset.state    presets + model catalog + workspaces + map
 *   POST     api/workspace-agent-preset.assign   { path, presetId?, selection? } -> state
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolveAbsolute } from 'node:path'

/** Loader-visible plugin name. */
export const name = 'workspace-agent-preset'
/** Services this plugin needs before it can work. */
export const inject = ['connection', 'sessionController']

export const STATE_PATH = '/api/workspace-agent-preset.state'
export const ASSIGN_PATH = '/api/workspace-agent-preset.assign'

const STORE_VERSION = 2
const MAX_PATH_LENGTH = 4096
const MAX_ID_LENGTH = 200
const PRESET_ID = /^[A-Za-z0-9_$.-]{1,200}$/
/** Model/provider/effort ids are adapter-owned strings: bounded, no control characters. */
const ADAPTER_ID = /^[^\u0000-\u001f\u007f]{1,200}$/
/** How long one model catalog read is reused across state/assign requests. */
const CATALOG_TTL_MS = 5000
/** Cordis keeps the unwrapped service under this well-known symbol. */
const ORIGINAL = Symbol.for('cordis.original')

function dshHome(env = process.env) {
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
}

/** Durable assignment file: `$DSH_HOME/workspace-agent-preset/assignments.json`. */
export function storeFile(env = process.env) {
  return join(dshHome(env), 'workspace-agent-preset', 'assignments.json')
}

/**
 * Comparison key for a directory.
 *
 * Workspace records are already `fs.realpath`-canonical, but a Session's `cwd`
 * may be spelled differently (junction, symlink, drive-letter case), so both
 * sides are canonicalized here. Windows filesystems are case-insensitive, so the
 * key is lowercased there: a preset must not silently stop applying because a
 * directory was entered with different capitalization.
 */
export function pathKey(input) {
  if (typeof input !== 'string' || input.trim() === '' || input.length > MAX_PATH_LENGTH) return undefined
  let absolute
  try {
    absolute = resolveAbsolute(input)
  } catch {
    return undefined
  }
  let canonical = absolute
  try {
    canonical = realpathSync.native(absolute)
  } catch {
    // A vanished directory still gets a stable key from its absolute spelling.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/** One bounded adapter-owned identifier, or undefined. */
function adapterId(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_ID_LENGTH || !ADAPTER_ID.test(trimmed)) return undefined
  return trimmed
}

/**
 * Normalize a stored/requested model selection.
 * @param value - `{ provider, model, reasoningEffort? }` shaped value.
 * @returns a detached selection, or undefined when it is not usable.
 */
export function normalizeSelection(value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  const provider = adapterId(value.provider)
  const model = adapterId(value.model)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = adapterId(value.reasoningEffort)
  return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort }
}

/** Whether two selections name the same complete choice. */
function sameSelection(left, right) {
  if (left === undefined || right === undefined || left === null || right === null) return left === right
  return left.provider === right.provider && left.model === right.model && (left.reasoningEffort ?? null) === (right.reasoningEffort ?? null)
}

function emptyStore() {
  return { version: STORE_VERSION, assignments: {} }
}

/** One stored assignment entry, or undefined when it carries nothing usable. */
function normalizeEntry(value) {
  if (typeof value === 'string') return PRESET_ID.test(value) ? { presetId: value } : undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = {}
  if (typeof value.presetId === 'string' && PRESET_ID.test(value.presetId)) entry.presetId = value.presetId
  const model = normalizeSelection(value.model)
  if (model !== undefined) entry.model = model
  return entry.presetId === undefined && entry.model === undefined ? undefined : entry
}

function readStore(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return emptyStore()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyStore()
  }
  const source = parsed && typeof parsed === 'object' ? parsed.assignments : undefined
  if (source === null || typeof source !== 'object') return emptyStore()
  const assignments = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof key !== 'string' || key === '') continue
    const entry = normalizeEntry(value)
    if (entry !== undefined) assignments[key] = entry
  }
  return { version: STORE_VERSION, assignments }
}

function writeStore(file, store) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function readJson(request) {
  try {
    const value = await request.json()
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function contentTypeIsJson(request) {
  const raw = request.headers.get('content-type')
  return raw !== null && raw.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

/**
 * The directory a create request refers to.
 * @param request - `SessionCreateRequest`-shaped object.
 * @param registry - workspace registry, when composed.
 * @returns the absolute directory, or undefined when the request names none.
 */
export function requestDirectory(request, registry) {
  const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : undefined
  if (workspaceId !== undefined && registry !== undefined && typeof registry.get === 'function') {
    const workspace = registry.get(workspaceId)
    if (workspace !== undefined && typeof workspace.path === 'string') return workspace.path
    // The registry may not have settled yet; a raw cwd is still authoritative.
  }
  return typeof request?.cwd === 'string' ? request.cwd : undefined
}

/**
 * Install an own-property override of one service method, restored on dispose.
 * @param service - live service value (a Cordis traceable proxy is unwrapped).
 * @param method - method name.
 * @param wrap - receives the original function and returns the replacement.
 * @returns disposer that restores the previous descriptor.
 */
export function overrideMethod(service, method, wrap) {
  // A traceable service proxy answers `symbols.original` with the unwrapped
  // object; writing through the proxy would land the override on a shadow.
  const target = service?.[ORIGINAL] ?? service
  if (target === null || typeof target !== 'object') throw new TypeError(`${name}: service is unavailable`)
  let found
  for (let proto = target; proto !== null && found === undefined; proto = Object.getPrototypeOf(proto)) {
    found = Reflect.getOwnPropertyDescriptor(proto, method)
  }
  if (found === undefined || typeof found.value !== 'function') throw new TypeError(`${name}: service has no callable ${method}()`)
  const own = Reflect.getOwnPropertyDescriptor(target, method)
  const installed = wrap(found.value)
  Object.defineProperty(target, method, {
    value: installed,
    writable: true,
    configurable: true,
    enumerable: own?.enumerable ?? found.enumerable ?? false,
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // Somebody wrapped over us: leave their override in place, our body is gone.
    if (target[method] !== installed) return
    if (own !== undefined) Object.defineProperty(target, method, own)
    else delete target[method]
  }
}

/**
 * The selection a Session has already recorded, if any.
 *
 * Deliberately distinguishes "recorded" from "carried": a live Agent always
 * reports *some* selection, because its constructor options fall back to the
 * deployment default. Only a recorded choice — the person picking a model on a
 * blank Session, or an earlier step of this plugin — must survive.
 *
 * Two seams, most specific first, because this decides whether user intent wins:
 * `agent.model.recordedSelection()` is the projection read the loop itself uses;
 * the durable `model/selection` event is the fallback if that method is gone.
 * @returns the recorded selection, or undefined when the Session has none.
 */
export function recordedSelection(agent) {
  try {
    if (typeof agent?.model?.recordedSelection === 'function') {
      const value = normalizeSelection(agent.model.recordedSelection())
      if (value !== undefined) return value
      return undefined
    }
  } catch {
    // Fall through to the durable log.
  }
  try {
    const events = agent?.session?.snapshotEvents?.()
    if (!Array.isArray(events)) return undefined
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'model/selection') {
        const value = normalizeSelection(events[index].data)
        if (value !== undefined) return value
      }
    }
  } catch {
    // A Session without a readable log is treated as unrecorded.
  }
  return undefined
}

/** Compact model-catalog entry the settings card can render.
 *
 * Written defensively row by row: a catalog is assembled from adapters this
 * plugin does not own, and one malformed row must not blank the whole picker.
 */
function catalogModel(model) {
  const reasoning = model?.reasoning
  const effortRows = reasoning !== null && typeof reasoning === 'object' && Array.isArray(reasoning.efforts)
    ? reasoning.efforts
        .filter((effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string' && effort.id !== '')
        .map((effort) => ({
          id: effort.id,
          name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
        }))
    : []
  return {
    id: String(model?.id ?? ''),
    name: typeof model?.name === 'string' && model.name !== '' ? model.name : String(model?.id ?? ''),
    description: typeof model?.description === 'string' ? model.description : '',
    reasoning:
      effortRows.length === 0
        ? null
        : {
            efforts: effortRows,
            defaultEffort:
              typeof reasoning.defaultEffort === 'string' && effortRows.some((row) => row.id === reasoning.defaultEffort)
                ? reasoning.defaultEffort
                : null,
          },
  }
}

/**
 * @param ctx - Host plugin context (`connection` and `sessionController` injected).
 * @param config - row configuration; `enabled: false` turns injection off.
 */
export function apply(ctx, config) {
  const file = storeFile()
  const enabled = config?.enabled !== false
  const verbose = config?.log === true

  let store = readStore(file)
  /** Preset ids known to activate. Injection of anything else is refused, so a
   * stale assignment can never turn Session creation into a hard failure. */
  let known = new Set()
  let refreshing
  const warned = new Set()

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {}
  }
  const note = (message) => {
    if (!verbose) return
    try {
      ctx.logger?.info?.(`${name}: ${message}`)
    } catch {}
  }

  const registry = () => {
    try {
      return ctx.get('workspaceRegistry')
    } catch {
      return undefined
    }
  }
  const presets = () => {
    try {
      return ctx.get('agentPresets')
    } catch {
      return undefined
    }
  }
  const agentsService = () => {
    try {
      return ctx.get('agents')
    } catch {
      return undefined
    }
  }
  const llmService = () => {
    try {
      return ctx.get('llm')
    } catch {
      return undefined
    }
  }

  /** Read the activation-capable preset roster; concurrent callers share one read. */
  const refreshKnown = () => {
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      const service = presets()
      if (service === undefined || typeof service.list !== 'function') {
        return
      }
      try {
        const rows = await service.list()
        known = new Set(rows.map((row) => row.id))
      } catch (error) {
        warn(`preset roster read failed: ${String(error)}`)
      }
    })().finally(() => {
      refreshing = undefined
    })
    return refreshing
  }

  /** One memoized model catalog read, so a settings refresh is not a provider storm. */
  let catalogMemo
  const modelCatalog = async () => {
    const controller = ctx.get('sessionController')
    if (controller !== undefined && typeof controller.modelCatalog === 'function') {
      if (catalogMemo !== undefined && Date.now() - catalogMemo.at < CATALOG_TTL_MS) return catalogMemo.value
      try {
        const value = await controller.modelCatalog()
        const trimmed = {
          default: normalizeSelection(value?.default) ?? null,
          groups: Array.isArray(value?.groups)
            ? value.groups.map((group) => ({
                id: String(group?.id ?? ''),
                name: typeof group?.name === 'string' && group.name !== '' ? group.name : String(group?.id ?? ''),
                models: Array.isArray(group?.models) ? group.models.map(catalogModel) : [],
              }))
            : [],
          failures: Array.isArray(value?.failures)
            ? value.failures.map((failure) => ({ id: String(failure?.id ?? ''), message: String(failure?.message ?? '') }))
            : [],
        }
        catalogMemo = { at: Date.now(), value: trimmed }
        return trimmed
      } catch (error) {
        warn(`model catalog read failed: ${String(error)}`)
      }
    }
    return { default: null, groups: [], failures: [] }
  }

  /** Whether a selection names a currently routable provider/model. */
  const routable = (catalog, selection) =>
    selection !== null &&
    selection !== undefined &&
    catalog.groups.some(
      (group) => group.id === selection.provider && group.models.some((model) => model.id === selection.model),
    )

  const assignmentFor = (directory) => {
    const key = pathKey(directory)
    if (key === undefined) return undefined
    return { key, entry: store.assignments[key] }
  }

  const refuseStale = (key, presetId) => {
    const stamp = `${key}\u0000${presetId}`
    if (warned.has(stamp)) return
    warned.add(stamp)
    warn(`workspace ${key} names preset "${presetId}", which is not in the roster; the request is left untouched`)
  }

  /**
   * Fill `agentPreset` for a create request.
   * @returns the request to forward, or a promise for it when the roster had to
   *   be read first (the warm path stays fully synchronous).
   */
  const decorate = (request) => {
    if (!enabled) return request
    if (request === null || typeof request !== 'object') return request
    if (typeof request.agentPreset === 'string' && request.agentPreset !== '') return request
    if (presets() === undefined) return request
    const found = assignmentFor(requestDirectory(request, registry()))
    if (found === undefined || found.entry?.presetId === undefined) return request
    const { key } = found
    const presetId = found.entry.presetId
    if (known.has(presetId)) {
      note(`session in ${key} starts with preset "${presetId}"`)
      return { ...request, agentPreset: presetId }
    }
    // Cold or stale roster: read it once, then decide. A failed read leaves the
    // request exactly as the caller sent it.
    return refreshKnown().then(
      () => {
        if (!known.has(presetId)) {
          refuseStale(key, presetId)
          return request
        }
        note(`session in ${key} starts with preset "${presetId}"`)
        return { ...request, agentPreset: presetId }
      },
      () => request,
    )
  }

  /** Selections already proven routable, so injection avoids a repeat lookup. */
  const accepted = new Map()
  const selectionToken = (selection) =>
    `${selection.provider}\u0000${selection.model}\u0000${selection.reasoningEffort ?? ''}`

  /**
   * Prove one selection is currently callable before installing it.
   *
   * `llm.resolveCallConfig` materializes the adapter's defaults and rejects an
   * effort the model does not advertise, so a selection left behind by a
   * removed model or a renamed effort is refused here instead of turning the
   * Session's first request into a hard failure.
   * @returns whether the selection may be recorded.
   */
  const usable = async (selection) => {
    const token = selectionToken(selection)
    if (accepted.has(token)) return true
    const llm = llmService()
    if (llm === undefined || typeof llm.resolveCallConfig !== 'function') return true
    try {
      await llm.resolveCallConfig(selection)
      // A capability answer is not cached forever: a provider may reload.
      accepted.set(token, true)
      return true
    } catch (error) {
      warn(
        `model selection ${selection.provider}/${selection.model}` +
          `${selection.reasoningEffort === undefined ? '' : ` (effort ${selection.reasoningEffort})`} ` +
          `is not usable right now; the Session keeps the global default: ${String(error)}`,
      )
      return false
    }
  }

  /** End-to-end evidence that the preset override is actually on the call path. */
  let injection = { state: 'untested', workspace: null, asked: null, got: null, at: null }
  /** End-to-end evidence that the workspace model was actually recorded. */
  let modelInjection = { state: 'untested', workspace: null, asked: null, got: null, at: null }

  const recordInjection = (asked, got, workspace) => {
    const ok = got === asked
    injection = { state: ok ? 'ok' : 'ignored', workspace, asked, got, at: new Date().toISOString() }
    if (!ok) {
      warn(
        `preset injection was NOT applied for ${workspace}: asked "${asked}", the Session ran "${String(got)}". ` +
          'This plugin overrides sessionController.create on the instance; if the platform now resolves that method from the prototype, the override is bypassed.',
      )
    }
  }

  const recordModelInjection = (asked, got, workspace) => {
    const ok = sameSelection(asked, got)
    modelInjection = {
      state: ok ? 'ok' : 'ignored',
      workspace,
      asked,
      got: got === undefined ? null : got,
      at: new Date().toISOString(),
    }
    if (!ok) {
      warn(
        `workspace model was NOT adopted for ${workspace}: asked ${selectionLabel(asked)}, the Agent reports ` +
          `${got === undefined ? 'no selection' : selectionLabel(got)}.`,
      )
    }
  }

  const presetCatalog = async () => {
    const service = presets()
    if (service === undefined || typeof service.list !== 'function') return { presets: [], defaultPresetId: null, active: false }
    const rows = await service.list()
    known = new Set(rows.map((row) => row.id))
    let defaultPresetId
    try {
      defaultPresetId = (await service.resolve()).id
    } catch {
      defaultPresetId = undefined
    }
    return {
      presets: rows.map((row) => ({
        id: row.id,
        name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
        description: typeof row.description === 'string' ? row.description : '',
        broken: typeof row.broken === 'string' ? row.broken : null,
        isDefault: row.id === defaultPresetId,
      })),
      defaultPresetId: defaultPresetId ?? null,
      active: true,
    }
  }

  const workspaceCatalog = (catalog) => {
    const service = registry()
    if (service === undefined || typeof service.list !== 'function') return []
    return service.list().map((workspace) => {
      const path = typeof workspace.path === 'string' ? workspace.path : ''
      const key = pathKey(path)
      const entry = key === undefined ? undefined : store.assignments[key]
      const assigned = entry?.presetId
      const usablePreset = assigned !== undefined && known.has(assigned)
      const selection = entry?.model ?? null
      const selectionUsable = selection === null ? false : routable(catalog, selection)
      return {
        workspaceId: String(workspace.id ?? ''),
        path,
        title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : path,
        sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
        presetId: usablePreset ? assigned : null,
        stalePresetId: assigned !== undefined && !usablePreset ? assigned : null,
        selection: selectionUsable ? selection : null,
        staleSelection: selection !== null && !selectionUsable ? selection : null,
        effectiveSelection: selectionUsable ? selection : catalog.default,
      }
    })
  }

  const statePayload = async () => {
    const [catalog, presetsRead] = await Promise.all([modelCatalog(), presetCatalog()])
    return {
      ok: true,
      enabled,
      active: presetsRead.active,
      presets: presetsRead.presets,
      defaultPresetId: presetsRead.defaultPresetId,
      models: catalog,
      workspaces: workspaceCatalog(catalog),
      storeFile: file,
      injection,
      modelInjection,
    }
  }

  // ---- routes -------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: STATE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return json(200, await statePayload())
          } catch (error) {
            return json(500, {
              ok: false,
              error: { code: 'workspace-agent-preset/state-failed', message: String(error), details: {} },
            })
          }
        },
      }),
    `${name}: state route`,
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ASSIGN_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (!contentTypeIsJson(request)) {
            return json(415, {
              ok: false,
              error: { code: 'workspace-agent-preset/content-type', message: 'content-type must be application/json', details: {} },
            })
          }
          const body = await readJson(request)
          const key = pathKey(body.path)
          if (key === undefined) {
            return json(400, {
              ok: false,
              error: { code: 'workspace-agent-preset/bad-path', message: 'path must name an absolute directory', details: {} },
            })
          }
          const touchesPreset = Object.hasOwn(body, 'presetId')
          const touchesSelection = Object.hasOwn(body, 'selection')
          if (!touchesPreset && !touchesSelection) {
            return json(400, {
              ok: false,
              error: {
                code: 'workspace-agent-preset/empty-change',
                message: 'name presetId or selection',
                details: {},
              },
            })
          }
          const current = store.assignments[key] ?? {}
          const next = { ...current }

          if (touchesPreset) {
            const requested = body.presetId
            if (requested !== null && requested !== undefined && (typeof requested !== 'string' || !PRESET_ID.test(requested))) {
              return json(400, {
                ok: false,
                error: { code: 'workspace-agent-preset/bad-preset', message: 'presetId must be a preset id or null', details: {} },
              })
            }
            if (typeof requested === 'string') {
              await refreshKnown()
              if (!known.has(requested)) {
                return json(404, {
                  ok: false,
                  error: {
                    code: 'workspace-agent-preset/unknown-preset',
                    message: `Unknown agent preset: ${requested}`,
                    details: { available: [...known] },
                  },
                })
              }
              next.presetId = requested
              delete warned[`${key}\u0000${requested}`]
            } else {
              delete next.presetId
            }
          }

          if (touchesSelection) {
            const requested = body.selection
            if (requested === null || requested === undefined) {
              delete next.model
            } else {
              const selection = normalizeSelection(requested)
              if (selection === undefined) {
                return json(400, {
                  ok: false,
                  error: {
                    code: 'workspace-agent-preset/bad-selection',
                    message: 'selection must be { provider, model, reasoningEffort? } or null',
                    details: {},
                  },
                })
              }
              const catalog = await modelCatalog()
              if (!routable(catalog, selection)) {
                return json(404, {
                  ok: false,
                  error: {
                    code: 'workspace-agent-preset/unknown-model',
                    message: `Unknown model: ${selection.provider}/${selection.model}`,
                    details: {},
                  },
                })
              }
              next.model = selection
            }
          }

          const written = { version: STORE_VERSION, assignments: { ...store.assignments } }
          if (next.presetId === undefined && next.model === undefined) delete written.assignments[key]
          else written.assignments[key] = next
          writeStore(file, written)
          store = written
          note(
            `assignment ${key} -> preset ${next.presetId ?? '(cleared)'}, model ` +
              `${next.model === undefined ? '(cleared)' : selectionLabel(next.model)}`,
          )
          return json(200, await statePayload())
        },
      }),
    `${name}: assign route`,
  )

  // ---- session-creation injection ----------------------------------------
  // Warm the roster before the first create so the first session in a
  // configured workspace is not the one that falls back to the global default.
  void refreshKnown()

  /**
   * Record the workspace model on a freshly created (or freshly claimed blank)
   * Session and report whether the Agent really took it.
   *
   * `agent.model.select` is the durable seam: the loop reads
   * `agent.model.current()` before every step, so the very first request already
   * carries the workspace route. Unlike `sessionController.selectModel` this
   * never re-saves the deployment default.
   *
   * A Session that already carries a recorded selection is left alone. `create`
   * reuses an existing blank Session when it has one, and the composer lets a
   * model be picked on a blank Session — that pick is the person's own choice,
   * so the workspace default must not overwrite it.
   */
  const installModel = async (sessionId, selection, workspace) => {
    const agents = agentsService()
    const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined || agent === null || typeof agent.model?.select !== 'function') {
      warn(`session ${sessionId} has no live Agent model seam; the workspace model was not applied`)
      return
    }
    const recorded = recordedSelection(agent)
    if (recorded !== undefined) {
      note(
        `session ${sessionId} in ${workspace} already records ${selectionLabel(recorded)}; ` +
          'the workspace model is not installed over it',
      )
      modelInjection = {
        state: 'kept',
        workspace,
        asked: selection,
        got: recorded,
        at: new Date().toISOString(),
      }
      return
    }
    if (!(await usable(selection))) return
    try {
      agent.model.select({ ...selection })
    } catch (error) {
      warn(`recording the workspace model on session ${sessionId} failed: ${String(error)}`)
      return
    }
    const got = typeof agent.model.current === 'function' ? agent.model.current() : undefined
    note(`session ${sessionId} in ${workspace} starts on ${selectionLabel(selection)}`)
    recordModelInjection(selection, got, workspace)
  }

  ctx.effect(() => {
    const controller = ctx.get('sessionController')
    if (controller === undefined) return () => {}
    return overrideMethod(controller, 'create', (original) =>
      function create(request) {
        let next
        try {
          next = decorate(request)
        } catch (error) {
          warn(`preset injection failed, creating without it: ${String(error)}`)
          next = request
        }
        const asked =
          next !== request && typeof next === 'object' && next !== null && typeof next.agentPreset === 'string'
            ? next.agentPreset
            : undefined
        const directory = requestDirectory(request, registry()) ?? ''
        let selection
        try {
          if (enabled) selection = assignmentFor(directory)?.entry?.model
        } catch (error) {
          warn(`workspace model lookup failed, creating without it: ${String(error)}`)
          selection = undefined
        }
        const forward = (resolved) => original.call(this, resolved)
        const creation =
          next !== null && typeof next === 'object' && typeof next.then === 'function'
            ? next.then(
                (resolved) => forward(resolved),
                () => forward(request),
              )
            : forward(next)
        // Keep the preset self-check observing without replacing the answer, and
        // await the model installation so the create reply means "ready to run
        // on the workspace route" — a prompt admitted right after it, as both
        // the sidebar and the composer do, then already sees that route.
        return Promise.resolve(creation).then(
          (value) => {
            if (asked !== undefined) recordInjection(asked, value?.agentPreset, directory)
            if (selection === undefined) return value
            const sessionId = value?.sessionId
            if (typeof sessionId !== 'string' || sessionId === '') return value
            return installModel(sessionId, selection, directory).then(
              () => value,
              () => value,
            )
          },
          (error) => {
            throw error
          },
        )
      },
    )
  }, `${name}: session create wrapper`)

  note(`active (${Object.keys(store.assignments).length} workspace assignment(s), store ${file})`)
}

/** Human-readable selection, for logs and the settings page. */
export function selectionLabel(selection) {
  if (selection === undefined || selection === null) return '(none)'
  const route = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort === undefined ? route : `${route} · ${selection.reasoningEffort}`
}
