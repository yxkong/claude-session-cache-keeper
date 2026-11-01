import type { EngineInterface, Register } from 'claude-code'
import { fresh, configure, mainStarted, mainAnswered, mainFinished, due, beginAttempt, finishAttempt, validatePolicy } from './policy'
import type { State, Usage } from './policy'

type Runtime = {
  state: State; root: string; id: string; sessionId: string; project: string; model: string;
  title: string; surface: string | null; revision: string; ended: boolean; polling: boolean;
  timer: { cancel(): void } | null; writing: Promise<void>; hadStep: boolean; cacheInvalidated: boolean; turnId: string | null;
  reconnecting: boolean; binding: Promise<void> | null; generation: number;
}
const clean = (text: string) => text.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
const safe = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)

async function publish($: EngineInterface, r: Runtime) {
  r.writing = r.writing.catch(() => {}).then(async () => {
    await $.fs.write(`${r.root}/sessions/${r.id}.json`, JSON.stringify({
      schema: 1, bridgeProtocol: 1, capabilities: { customAttemptBudget: true }, pluginVersion: '0.2.2', id: r.id, sessionId: r.sessionId, project: r.project, model: r.model,
      title: r.title, surface: r.surface, heartbeat: await $.clock.now(), active: !r.ended,
      controlRevision: r.revision, ...r.state,
    }))
  })
  return r.writing
}
async function readControl($: EngineInterface, r: Runtime, now: number) {
  let control: any
  try { control = JSON.parse(await $.fs.read(`${r.root}/controls/${r.id}.json`)) }
  catch {
    if (r.state.enabled) configure(r.state, r.state.policy, false, now, Math.random)
    return
  }
  if (control?.schema !== 1 || control.id !== r.id || typeof control.revision !== 'string'
    || typeof control.enabled !== 'boolean' || !validatePolicy(control.policy)) {
    configure(r.state, r.state.policy, false, now, Math.random)
    return
  }
  if (control.revision === r.revision) return
  r.revision = control.revision
  configure(r.state, control.policy, control.enabled, now, Math.random)
}
async function runAttempt($: EngineInterface, r: Runtime, at: number) {
  const state = r.state
  if (!await ensureSession($, r) || r.state !== state || !due(state, await $.clock.now())) return
  const epoch = beginAttempt(state)
  let sentAt = at
  let usage: Usage | null = null
  try {
    // Publish the counted attempt before spending. A broken bridge fails closed.
    await publish($, r)
    if (!await ensureSession($, r) || r.state !== state) { state.inFlight = false; return }
    await readControl($, r, await $.clock.now())
    sentAt = await $.clock.now()
    if (r.state !== state || epoch !== state.epoch || !state.enabled || state.busy || r.ended
      || sentAt >= state.lastCacheAt + 285_000) { state.inFlight = false; return }
    const result: any = await $.model.fork({ prompt: 'Reply with exactly: ok. Do not explain or perform any task.' })
    if (result && result.isAnswered !== false) usage = result.usage ?? null
  } catch { /* No retry: a failed send still consumes one attempt. */ }
  if (r.state !== state) { state.inFlight = false; return }
  finishAttempt(state, usage, sentAt, epoch, Math.random)
  await publish($, r).catch(() => {})
}
async function tick($: EngineInterface, r: Runtime) {
  if (r.polling || (r.ended && !r.reconnecting)) return
  r.polling = true
  try {
    if (!await ensureSession($, r)) return
    const now = await $.clock.now()
    await readControl($, r, now)
    const send = due(r.state, now)
    await publish($, r)
    if (send && !r.state.inFlight) void runAttempt($, r, now)
  } catch {
    configure(r.state, r.state.policy, false, await $.clock.now(), Math.random)
  } finally { r.polling = false }
}
async function bind($: EngineInterface, r: Runtime, surface: string | null) {
  const generation = ++r.generation
  if (r.id) {
    r.ended = true; r.reconnecting = true
    configure(r.state, r.state.policy, false, await $.clock.now(), Math.random)
    await publish($, r)
  }
  const sessionId = await $.session.id()
  const project = await $.session.cwd()
  const model = await $.session.model()
  const home = await $.env.get('HOME') || await $.env.get('USERPROFILE')
  if (!home) throw new Error('CacheKeeper cannot find the user home directory')
  const root = await $.env.get('CACHE_KEEPER_DATA_DIR') || `${home.replace(/\\/g, '/')}/.cache-keeper`
  const messages = await $.session.messages()
  const now = await $.clock.now()
  if (generation !== r.generation) return
  r.timer?.cancel()
  r.state = fresh(); r.ended = false; r.reconnecting = false; r.revision = ''; r.hadStep = false; r.cacheInvalidated = false; r.turnId = null; r.surface = surface
  r.sessionId = sessionId; r.project = project; r.model = model; r.root = root
  r.id = `${safe(sessionId)}-${now.toString(36)}-${Math.floor(Math.random() * 0x100000000).toString(36)}`
  r.title = clean(messages.find(m => m.role === 'user' && m.text.trim())?.text || r.project.split('/').pop() || r.sessionId)
  await publish($, r)
  if (generation === r.generation && !r.ended) r.timer = $.clock.every(2000, () => { void tick($, r) })
}
async function ensureSession($: EngineInterface, r: Runtime): Promise<boolean> {
  if (!r.id || (r.ended && !r.reconnecting)) return false
  if (r.binding) { await r.binding; return !r.ended }
  const sid = await $.session.id()
  if (sid === r.sessionId) return !r.ended
  // A clear/resume does not re-fire session.start for an already loaded mod.
  // Serialize rebinding; controls are always tied to a fresh connection ID.
  if (!r.binding) r.binding = bind($, r, r.surface)
  try { await r.binding } finally { r.binding = null }
  return !r.ended
}

export const register: Register = on => {
  const r: Runtime = {
    state: fresh(), root: '', id: '', sessionId: '', project: '', model: '', title: '', surface: null,
    revision: '', ended: false, polling: false, timer: null, writing: Promise.resolve(), hadStep: false, cacheInvalidated: false,
    turnId: null, reconnecting: false, binding: null, generation: 0,
  }
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await bind($, r, e.surface)
    await $.command.register({ name: 'cache-keeper', description: '查看本会话缓存保活状态；off 停止本会话。开启与设置请在 CacheKeeper 应用操作。', argumentHint: '[status | off]', immediate: true })
    return result
  })
  on('command.run', { command: 'cache-keeper' }, async ($, e) => {
    await ensureSession($, r)
    if (e.args.trim() === 'off') {
      configure(r.state, r.state.policy, false, await $.clock.now(), Math.random)
      await publish($, r)
    }
    return { text: `${r.title}\n保活${r.state.enabled ? '已开启' : '已关闭'} · ${r.state.attempts}/${r.state.policy.maxAttempts} 次 · ${r.state.policy.minSeconds}–${r.state.policy.maxSeconds} 秒\n状态：${r.state.phase}。在 CacheKeeper 应用中选择这条会话进行设置。` }
  })
  on('turn.start', async ($, e, next) => {
    if (!e.agentId && await ensureSession($, r)) {
      r.hadStep = false; r.cacheInvalidated = false; r.turnId = e.turnId; r.state.busy = true
    }
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    const main = !e.agentId && await ensureSession($, r) && r.turnId === e.turnId
    const state = r.state
    const at = await $.clock.now()
    if (main) { r.hadStep = true; r.model = e.model; mainStarted(state, at) }
    const epoch = state.epoch
    const result = yield* next(e)
    if (main && r.state === state && !r.ended && state.epoch === epoch) {
      mainAnswered(state, result.usage, at); await publish($, r)
    }
    return result
  })
  on('turn.complete', async ($, e, next) => {
    const state = r.state, turnId = r.turnId
    const result = await next(e)
    if (e.agentId || turnId !== e.turnId || !await ensureSession($, r)
      || r.state !== state || r.turnId !== turnId) return result
    const now = await $.clock.now()
    // The fallback is only for hosts that did not expose turn.step, and uses
    // the beginning of the response, never its completion, as the cache clock.
    if (!r.hadStep && !r.cacheInvalidated && e.usage) {
      const at = now - e.durationMs
      mainStarted(r.state, at); mainAnswered(r.state, e.usage, at)
    }
    r.hadStep = false; r.turnId = null
    mainFinished(r.state, now, Math.random)
    if (e.isAborted) configure(r.state, r.state.policy, false, now, Math.random)
    await publish($, r)
    return result
  })
  on('session.end', async ($, e, next) => {
    if (e.sessionId !== r.sessionId) return next(e)
    r.generation++
    r.ended = true; r.timer?.cancel(); r.timer = null
    r.reconnecting = e.reason === 'clear' || e.reason === 'resume'
    r.turnId = null
    configure(r.state, r.state.policy, false, await $.clock.now(), Math.random)
    await publish($, r).catch(() => {})
    // Keep only an identity watcher across clear/resume; it cannot send while
    // the old ID remains current. An actual exit leaves no timer behind.
    if (r.reconnecting) r.timer = $.clock.every(2000, () => { void tick($, r) })
    return next(e)
  })
  on('session.append', { door: 'notice' }, async ($, e, next) => {
    const state = r.state
    const result = await next(e)
    if (!e.agentId && e.message.name === 'compact_boundary' && await ensureSession($, r) && r.state === state) {
      state.epoch++; state.lastCacheAt = 0; state.nextAt = 0; state.cacheTokens = 0
      // Turn totals can include pre-compaction requests. Only a subsequent
      // turn.step may establish a new cache clock for this ongoing turn.
      r.cacheInvalidated = true
      due(state, await $.clock.now())
      await publish($, r)
    }
    return result
  })
}
