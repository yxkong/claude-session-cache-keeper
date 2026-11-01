import { defaults, validatePolicy } from '../../plugin/hooks/policy.ts';
import manifest from '../../plugin/.claude-plugin/plugin.json' with { type:'json' };
export { defaults, validatePolicy };
export const EXECUTOR_VERSION = manifest.version;
export const isCurrent = s => s.bridgeProtocol === 1 || (s.bridgeProtocol === undefined && /^0\.2\.\d+$/.test(s.pluginVersion || ''));
export const validID = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,219}$/.test(id);
export const online = (s, now = Date.now()) => s.active === true && Number.isFinite(s.heartbeat) && now - s.heartbeat < 10_000 && s.heartbeat <= now + 5000;
export function validSnapshot(s, id) {
  return s?.schema === 1 && s.id === id && validID(s.id) && validID(s.sessionId)
    && typeof s.title === 'string' && typeof s.project === 'string' && typeof s.model === 'string'
    && typeof s.enabled === 'boolean' && typeof s.active === 'boolean' && Number.isFinite(s.heartbeat)
    && validatePolicy(s.policy) && Number.isSafeInteger(s.attempts) && s.attempts >= 0
    && ['nextAt', 'lastCacheAt', 'cacheTokens', 'readTokens', 'writeTokens', 'outputTokens'].every(k => Number.isFinite(s[k]) && s[k] >= 0);
}
