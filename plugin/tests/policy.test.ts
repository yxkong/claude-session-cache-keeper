import { describe, expect, test } from 'claude-code/testing'
import { defaults, fresh, configure, mainStarted, mainAnswered, mainFinished, due, beginAttempt, finishAttempt, validatePolicy } from '../hooks/policy'

const START = 1_000_000
const hit = { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 1 }
function ready(enabled = true) {
  const s = fresh()
  configure(s, { ...defaults }, enabled, START, () => 0)
  mainStarted(s, START)
  mainAnswered(s, hit, START)
  mainFinished(s, START + 1000, () => 0)
  return s
}

describe('per-session explicit opt-in and budget', () => {
  test('normal traffic does not turn a fresh session on', () => {
    const s = ready(false)
    expect(s.enabled).toBe(false)
    expect(due(s, START + 270_000)).toBe(false)
  })
  test('enabling one state does not enable another session', () => {
    expect(ready().enabled).toBe(true)
    expect(ready(false).enabled).toBe(false)
  })
  test('random interval includes both requested boundaries', () => {
    const a = ready(), b = ready()
    configure(b, { ...defaults }, true, START + 1000, () => 0.999999)
    expect(a.nextAt).toBe(START + 260_000)
    expect(b.nextAt).toBe(START + 280_000)
  })
  test('a sixth successful keepalive does not reset the budget or allow a seventh', () => {
    const s = ready()
    for (let i = 1; i <= 6; i++) {
      const at = START + i * 260_000
      expect(due(s, at)).toBe(true)
      const epoch = beginAttempt(s)
      finishAttempt(s, hit, at, epoch, () => 0)
      expect(s.attempts).toBe(i)
    }
    expect(due(s, START + 7 * 260_000)).toBe(false)
    expect(s.phase).toBe('limit')
  })
  test('settings edits cannot replenish an existing idle budget', () => {
    const s = ready()
    finishAttempt(s, hit, START + 260_000, beginAttempt(s), () => 0)
    configure(s, { ...defaults, minSeconds: 270 }, true, START + 261_000, () => 0)
    expect(s.attempts).toBe(1)
  })
  test('only a normal model request starts a fresh budget', () => {
    const s = ready()
    finishAttempt(s, hit, START + 260_000, beginAttempt(s), () => 0)
    mainStarted(s, START + 270_000)
    expect(s.attempts).toBe(0)
    mainAnswered(s, hit, START + 270_000)
    mainFinished(s, START + 271_000, () => 0)
    expect(s.nextAt).toBe(START + 530_000)
  })
  test('failures consume an attempt and stop without unbounded retries', () => {
    const s = ready()
    finishAttempt(s, null, START + 260_000, beginAttempt(s), () => 0)
    expect(s.attempts).toBe(1)
    expect(s.phase).toBe('error')
    expect(due(s, START + 270_000)).toBe(false)
  })
  test('a partial prefix hit is not treated as a successful keepalive', () => {
    const s = ready()
    finishAttempt(s, { ...hit, cache_read_input_tokens: 5000 }, START + 260_000, beginAttempt(s), () => 0)
    expect(s.phase).toBe('miss')
    expect(due(s, START + 270_000)).toBe(false)
  })
  test('sleep and long responses cannot schedule an already-expired cache write', () => {
    const s = ready()
    expect(due(s, START + 301_000)).toBe(false)
    expect(s.phase).toBe('expired')
    const long = fresh()
    configure(long, defaults, true, START, () => 0)
    mainStarted(long, START)
    mainAnswered(long, hit, START)
    mainFinished(long, START + 301_000, () => 0)
    expect(due(long, START + 302_000)).toBe(false)
  })
  test('off and a new normal request invalidate an in-flight result', () => {
    const s = ready()
    const epoch = beginAttempt(s)
    configure(s, defaults, false, START + 261_000, () => 0)
    finishAttempt(s, hit, START + 260_000, epoch, () => 0)
    expect(s.enabled).toBe(false)
    expect(s.nextAt).toBe(0)
    const t = ready(), old = beginAttempt(t)
    mainStarted(t, START + 270_000)
    finishAttempt(t, hit, START + 260_000, old, () => 0)
    expect(t.lastCacheAt).toBe(0)
    expect(t.busy).toBe(true)
  })
  test('token threshold is local to this session', () => {
    const s = ready()
    configure(s, { ...defaults, minCachedTokens: 200_000 }, true, START, () => 0)
    expect(due(s, START + 270_000)).toBe(false)
    expect(s.phase).toBe('tokens')
  })
  test('custom positive budgets above six are accepted; invalid values are rejected', () => {
    expect(validatePolicy({ ...defaults, maxAttempts: 99 })).toBe(true)
    expect(validatePolicy({ ...defaults, maxAttempts: 0 })).toBe(false)
    expect(validatePolicy({ ...defaults, maxAttempts: 1.5 })).toBe(false)
    expect(validatePolicy({ ...defaults, maxSeconds: 300 })).toBe(false)
    expect(validatePolicy({ ...defaults, minSeconds: 280, maxSeconds: 260 })).toBe(false)
  })
})
