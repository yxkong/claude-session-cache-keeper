// Adapted from cache-tax's request clock, single-flight fork and cache-hit checks.
// Unlike upstream, there is no global switch or automatic cold-write activation.
export type Policy = { minSeconds: number; maxSeconds: number; maxAttempts: number; minCachedTokens: number }
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export const defaults: Policy = { minSeconds: 260, maxSeconds: 280, maxAttempts: 6, minCachedTokens: 0 }
// Exported to the build-time Rust contract generator; this remains the sole owner.
export const limits = { minSeconds: 30, maxSeconds: 280, maxCachedTokens: 10_000_000 }
export const TTL_MS = 300_000
const SAFETY_MS = 15_000
export type Phase = 'off' | 'waiting' | 'working' | 'scheduled' | 'sending' | 'limit' | 'expired' | 'tokens' | 'miss' | 'error'
export type State = {
  enabled: boolean; policy: Policy; attempts: number; nextAt: number; lastCacheAt: number;
  lastRequestAt: number; busy: boolean; inFlight: boolean; epoch: number; cacheTokens: number;
  phase: Phase; stopped: '' | 'miss' | 'error'; readTokens: number; writeTokens: number;
  outputTokens: number; lastHit: boolean | null;
}
export const fresh = (): State => ({
  enabled: false, policy: { ...defaults }, attempts: 0, nextAt: 0, lastCacheAt: 0,
  lastRequestAt: 0, busy: false, inFlight: false, epoch: 0, cacheTokens: 0,
  phase: 'off', stopped: '', readTokens: 0, writeTokens: 0, outputTokens: 0, lastHit: null,
})
export function validatePolicy(p: unknown): p is Policy {
  if (!p || typeof p !== 'object') return false
  const a = p as Policy
  return [a.minSeconds, a.maxSeconds, a.maxAttempts, a.minCachedTokens].every(Number.isSafeInteger)
    && a.minSeconds >= limits.minSeconds && a.maxSeconds <= limits.maxSeconds && a.minSeconds <= a.maxSeconds
    && a.maxAttempts >= 1 && a.minCachedTokens >= 0 && a.minCachedTokens <= limits.maxCachedTokens
}
function resetBudget(s: State) {
  s.attempts = 0; s.readTokens = 0; s.writeTokens = 0; s.outputTokens = 0; s.lastHit = null; s.stopped = ''
}
function plan(s: State, now: number, random: () => number) {
  if (!s.enabled) { s.phase = 'off'; s.nextAt = 0; return }
  if (s.stopped) { s.phase = s.stopped; s.nextAt = 0; return }
  if (s.busy) { s.phase = 'working'; return }
  if (s.inFlight) { s.phase = 'sending'; return }
  if (s.attempts >= s.policy.maxAttempts) { s.phase = 'limit'; s.nextAt = 0; return }
  if (!s.lastCacheAt || !s.cacheTokens) { s.phase = 'waiting'; s.nextAt = 0; return }
  if (s.cacheTokens < s.policy.minCachedTokens) { s.phase = 'tokens'; s.nextAt = 0; return }
  if (now >= s.lastCacheAt + TTL_MS - SAFETY_MS) { s.phase = 'expired'; s.nextAt = 0; return }
  if (!s.nextAt) {
    const fraction = Math.max(0, Math.min(0.999999999, random()))
    const seconds = s.policy.minSeconds + Math.floor(fraction * (s.policy.maxSeconds - s.policy.minSeconds + 1))
    s.nextAt = s.lastCacheAt + seconds * 1000
  }
  s.phase = 'scheduled'
}
export function configure(s: State, p: Policy, enabled: boolean, now: number, random: () => number) {
  if (!validatePolicy(p)) throw new Error('Invalid keepalive policy')
  if (enabled && !s.enabled) resetBudget(s)
  if (enabled !== s.enabled) s.epoch++
  s.policy = { ...p }; s.enabled = enabled; s.nextAt = 0
  plan(s, now, random)
}
export function mainStarted(s: State, at: number) {
  s.epoch++; resetBudget(s); s.busy = true; s.lastRequestAt = at
  s.lastCacheAt = 0; s.nextAt = 0; s.cacheTokens = 0
  s.phase = s.enabled ? 'working' : 'off'
}
export function mainAnswered(s: State, u: Usage | null | undefined, at: number) {
  if (!u) return
  const tokens = u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (Number.isFinite(tokens) && tokens > 0) { s.cacheTokens = tokens; s.lastCacheAt = at }
}
export function mainFinished(s: State, now: number, random: () => number) {
  s.busy = false
  plan(s, now, random)
}
export function due(s: State, now: number): boolean {
  plan(s, now, () => 0)
  return s.phase === 'scheduled' && s.nextAt > 0 && now >= s.nextAt
}
export function beginAttempt(s: State): number {
  s.attempts++; s.inFlight = true; s.nextAt = 0; s.phase = 'sending'
  return s.epoch
}
export function finishAttempt(s: State, u: Usage | null, startedAt: number, epoch: number, random: () => number) {
  s.inFlight = false
  if (epoch !== s.epoch) return
  if (!u || !Object.values(u).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    s.stopped = 'error'; plan(s, startedAt, random); return
  }
  s.readTokens += u.cache_read_input_tokens; s.writeTokens += u.cache_creation_input_tokens; s.outputTokens += u.output_tokens
  const hit = u.cache_read_input_tokens >= s.cacheTokens * 0.9 && u.cache_read_input_tokens > 0
    && u.cache_creation_input_tokens < u.cache_read_input_tokens * 0.1
  s.lastHit = hit
  if (!hit) s.stopped = 'miss'
  else s.lastCacheAt = startedAt
  plan(s, startedAt, random)
}
