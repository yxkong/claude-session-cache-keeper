import test from 'node:test';
import assert from 'node:assert/strict';
import { rootsFor, homeFrom, executableCandidates } from '../app/core/platform.mjs';
test('data and transcript paths are native to Windows, Linux and macOS', () => {
  assert.equal(homeFrom({ USERPROFILE: 'C:\\Users\\demo' }), 'C:\\Users\\demo');
  assert.equal(rootsFor({ platform: 'win32', home: 'C:\\Users\\demo', env: {} })[0], 'C:\\Users\\demo\\.cache-keeper');
  assert.deepEqual(rootsFor({ platform: 'linux', home: '/home/demo', env: {} }), ['/home/demo/.cache-keeper']);
  assert.deepEqual(rootsFor({ platform: 'darwin', home: '/Users/demo', env: {} }), ['/Users/demo/.cache-keeper', '/Users/demo/Library/Application Support/ClaudeCacheKeeper']);
  assert.deepEqual(rootsFor({ platform: 'darwin', home: '/Users/demo', env: { CACHE_KEEPER_DATA_DIR: '/isolated' } }), ['/isolated']);
  assert.equal(rootsFor({ platform: 'win32', env: { HOME: 'C:\\Custom Home', USERPROFILE: 'C:\\Users\\demo' } })[0], 'C:\\Custom Home\\.cache-keeper');
});
test('Windows executable candidates include native and npm command wrappers', () => {
  const candidates = executableCandidates({ platform: 'win32', env: { PATH: 'C:\\Tools;C:\\Npm', PATHEXT: '.EXE;.CMD' }, home: 'C:\\Users\\demo' });
  assert.ok(candidates.includes('C:\\Tools\\claude.exe'));
  assert.ok(candidates.includes('C:\\Npm\\claude.cmd'));
});
