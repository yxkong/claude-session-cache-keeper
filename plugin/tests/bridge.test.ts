import { expect, mock, test, tier } from 'claude-code/testing'
import type { EngineInterface, On, TurnCompleteInput } from 'claude-code'

tier('user')
const START = 1_000_000
const usage = { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 1, model: 'claude-sonnet-4-6' }
function world(on: On, gate?: () => Promise<void>, environment: Record<string, string | undefined> = { HOME: '/synthetic', CACHE_KEEPER_DATA_DIR: '/bridge' }) {
  const files = new Map<string, string>()
  const forks: unknown[] = []
  let sessionID = 'S1'
  let wrote: ((s: any) => void) | undefined
  on('env.get', ($, e) => ({ value: environment[e.name] }))
  on('fs.read', ($, e) => { if (!files.has(e.path)) throw new Error('ENOENT'); return { value: files.get(e.path) } })
  on('fs.write', ($, e) => { files.set(e.path, e.text); if (e.path.includes('/sessions/')) wrote?.(JSON.parse(e.text)); return { value: undefined } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('session.id', () => ({ value: sessionID }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('session.model', () => ({ value: usage.model }))
  on('session.messages', () => ({ value: [{ role: 'user', text: '测试项目会话', toolUses: [] }] }))
  on('command.register', () => ({ value: { command: 'cache-keeper' } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.append', ($, e, next) => next(e))
  on('turn.step', async function* ($, e) {
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  on('ui.status', () => ({ value: undefined }))
  on('model.fork', async ($, e) => {
    forks.push(e); await gate?.()
    // ModelForkUsage has four token counts; unlike TurnUsage it has no model.
    const { model, ...tokens } = usage
    return { value: { text: 'ok', usage: tokens } }
  })
  const snapshot = () => JSON.parse([...files].filter(([p]) => p.includes('/sessions/')).at(-1)![1])
  const control = (enabled: boolean, extra = {}) => {
    const s = snapshot()
    files.set(`/bridge/controls/${s.id}.json`, JSON.stringify({ schema: 1, id: s.id, revision: String(Math.random()), enabled, policy: { minSeconds: 260, maxSeconds: 280, maxAttempts: 6, minCachedTokens: 0, ...extra } }))
  }
  return { files, forks, snapshot, control, switchTo: (id: string) => { sessionID = id }, onSnapshot: (fn: (s: any) => void) => { wrote = fn } }
}
const turn = { answer: 'done', durationMs: 0, isAborted: false, reason: 'answer' as const, turnId: 'T1', usage }
async function complete($: EngineInterface, input: TurnCompleteInput = turn) {
  await $.turn.start({ turnId: input.turnId })
  return $.turn.complete(input)
}
// The real built-in routes these seams past user-tier hooks. The fixture only
// models that routing; it neither weakens nor modifies the installed guard.
const guarded = { plugins: [{ name: 'cc-plugin-sec-default', tier: 'prepend' as const, register(on: On) {
  on('classic.*', ($, e, next) => next.to(e, 'append'))
  on('session.compact', ($, e, next) => next.to(e, 'append'))
} }] }

test('publishes a selectable session, but absent controls never send a request', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  expect(w.snapshot().enabled).toBe(false)
  expect(w.snapshot().sessionId).toBe('S1')
  expect(w.snapshot().pluginVersion).toBe('0.2.1')
  expect(w.snapshot().bridgeProtocol).toBe(1)
  await complete($)
  await clock.advance(600_000)
  expect(w.forks.length).toBe(0)
})
test('only a matching explicit control enables forks and off cancels future work', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($)
  await clock.advance(282_000)
  expect(w.forks.length).toBe(1)
  expect(w.snapshot().attempts).toBe(1)
  w.control(false)
  await clock.advance(600_000)
  expect(w.forks.length).toBe(1)
  expect(w.snapshot().enabled).toBe(false)
})
test('a malformed or foreign control cannot enable the session', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true, { maxAttempts: 0 })
  await complete($)
  await clock.advance(600_000)
  expect(w.snapshot().enabled).toBe(false)
  expect(w.forks.length).toBe(0)
})
test('a stopped turn disables the current session until another explicit enable', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($, { ...turn, reason: 'aborted', isAborted: true })
  await clock.advance(600_000)
  expect(w.snapshot().enabled).toBe(false)
  expect(w.forks.length).toBe(0)
})

test('a cleared conversation gets a fresh, disabled connection identity', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  const oldID = w.snapshot().id
  w.control(true)
  await clock.advance(2000)
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  w.switchTo('S2')
  await clock.advance(2000)
  expect(w.snapshot().id === oldID).toBe(false)
  expect(w.snapshot().enabled).toBe(false)
  await complete($)
  await clock.advance(600_000)
  expect(w.forks.length).toBe(0)
})

test('turn.step anchors TTL at request start even if the response is slow', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await $.turn.start({ turnId: 'slow' })
  for await (const chunk of $.turn.step({ turnId: 'slow', index: 0, model: usage.model, messageCount: 2 })) void chunk
  await clock.advance(301_000)
  await $.turn.complete({ ...turn, turnId: 'slow', durationMs: 301_000 })
  await clock.advance(280_000)
  expect(w.forks.length).toBe(0)
  expect(w.snapshot().phase).toBe('expired')
})

test('an old fork response cannot warm or enable a cleared conversation', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const w = world(on, () => held)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($)
  await clock.advance(282_000)
  expect(w.forks.length).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  w.switchTo('S2')
  await clock.advance(2000)
  release()
  await clock.advance(4000)
  expect(w.snapshot().enabled).toBe(false)
  expect(w.snapshot().attempts).toBe(0)
  expect(w.snapshot().lastCacheAt).toBe(0)
})

test('clear reconnects disabled even when the built-in skips classic.SessionStart', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  const oldID = w.snapshot().id
  w.control(true)
  await clock.advance(2000)
  await complete($)
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  w.switchTo('S2')
  await $.classic.SessionStart({ session_id: 'S2', source: 'clear' })
  await clock.advance(4000)
  expect(w.snapshot().sessionId).toBe('S2')
  expect(w.snapshot().id === oldID).toBe(false)
  expect(w.snapshot().enabled).toBe(false)
  expect(JSON.parse(w.files.get(`/bridge/sessions/${oldID}.json`)!).active).toBe(false)
  await clock.advance(600_000)
  expect(w.forks.length).toBe(0)
})

test('polling discovers a changed session identity without a classic event', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($)
  w.switchTo('S2')
  await clock.advance(282_000)
  expect(w.snapshot().sessionId).toBe('S2')
  expect(w.snapshot().enabled).toBe(false)
  expect(w.forks.length).toBe(0)
})

test('a main turn detects a session switch before the next polling interval', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  w.switchTo('S2')
  await $.turn.start({ turnId: 'T2' })
  for await (const chunk of $.turn.step({ turnId: 'T2', index: 0, model: usage.model, messageCount: 2 })) void chunk
  await $.turn.complete({ ...turn, turnId: 'T2' })
  await clock.advance(282_000)
  expect(w.snapshot().sessionId).toBe('S2')
  expect(w.snapshot().enabled).toBe(false)
  expect(w.forks.length).toBe(0)
})

test('an identity change after recording an attempt prevents its API send', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($)
  w.onSnapshot(s => { if (s.inFlight) w.switchTo('S2') })
  await clock.advance(282_000)
  expect(w.forks.length).toBe(0)
  expect(w.snapshot().sessionId).toBe('S2')
  expect(w.snapshot().enabled).toBe(false)
})

test('compaction boundary invalidates the old cache without a session.compact hook', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($)
  expect(w.snapshot().cacheTokens).toBeGreaterThan(0)
  await $.session.append({ door: 'notice', uuid: 'compact-1', origin: { kind: 'composer' }, message: { type: 'system', name: 'compact_boundary', content: [] } })
  await clock.advance(282_000)
  expect(w.snapshot().cacheTokens).toBe(0)
  expect(w.snapshot().lastCacheAt).toBe(0)
  expect(w.forks.length).toBe(0)
})

test('a result from a previous conversation never warms the new connection', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 'old-turn' })
  w.switchTo('S2')
  await clock.advance(2000)
  await $.turn.complete({ ...turn, turnId: 'old-turn' })
  expect(w.snapshot().sessionId).toBe('S2')
  expect(w.snapshot().lastCacheAt).toBe(0)
  expect(w.snapshot().cacheTokens).toBe(0)
})

test('normal explicit keepalive still works under the built-in routing guard', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($)
  await clock.advance(282_000)
  expect(w.forks.length).toBe(1)
  expect(w.snapshot().lastHit).toBe(true)
  expect(w.snapshot().attempts).toBe(1)
})

test('resume retires the old connection and waits safely for the target session', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($)
  await $.session.end({ reason: 'resume', sessionId: 'S1', resume: { id: 'S1' } })
  await clock.advance(282_000)
  expect(w.forks.length).toBe(0)
  expect(w.snapshot().active).toBe(false)
  w.switchTo('resumed-session')
  await complete($, { ...turn, turnId: 'resumed-turn' })
  expect(w.snapshot().sessionId).toBe('resumed-session')
  expect(w.snapshot().active).toBe(true)
  expect(w.snapshot().enabled).toBe(false)
  await clock.advance(282_000)
  expect(w.forks.length).toBe(0)
})

test('a real process exit cannot reconnect or send later requests', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await complete($)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'S1', resume: { id: 'S1' } })
  w.switchTo('S2')
  await clock.advance(600_000)
  expect(w.snapshot().sessionId).toBe('S1')
  expect(w.snapshot().active).toBe(false)
  expect(w.forks.length).toBe(0)
})

test('turn-level fallback cannot restore pre-compaction cache usage', guarded, async ($, on) => {
  const clock = mock.clock(on, { now: START }), w = world(on)
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  w.control(true)
  await clock.advance(2000)
  await $.turn.start({ turnId: 'compacted-turn' })
  await $.session.append({ door: 'notice', uuid: 'compact-in-turn', origin: { kind: 'composer' }, message: { type: 'system', name: 'compact_boundary', content: [] } })
  await $.turn.complete({ ...turn, turnId: 'compacted-turn' })
  await clock.advance(282_000)
  expect(w.snapshot().cacheTokens).toBe(0)
  expect(w.forks.length).toBe(0)
})

test('Windows USERPROFILE connects to the shared home-directory bridge', async ($, on) => {
  mock.clock(on, { now: START })
  const w = world(on, undefined, { USERPROFILE: 'C:\\Users\\Synthetic User' })
  await $.session.start({ cwd: 'C:/work/project', surface: 'desktop', isInteractive: true })
  // A non-Windows test host canonicalizes drive-letter paths beneath its cwd.
  // This verifies the intended Windows suffix, not native Windows execution.
  expect([...w.files.keys()].join('\n')).toContain('C:/Users/Synthetic User/.cache-keeper/sessions/')
  expect(w.snapshot().enabled).toBe(false)
})
