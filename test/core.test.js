'use strict';
// Runs against a throwaway fake ~/.claude. A fake "extension" imitates what the real one does:
// it reacts to remoteControlAtStartup *changes* and switches on sessions that are off.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'));
const claudeDir = path.join(root, '.claude');
fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(claudeDir, 'ide'), { recursive: true });
const settingsFile = path.join(claudeDir, 'settings.json');

const procs = new Map([[100, 'code.exe'], [201, 'claude.exe'], [202, 'claude.exe'], [203, 'claude.exe'], [204, 'claude.exe']]);
const writeSession = (pid, extra) =>
  fs.writeFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: `sid-${pid}`, name: `s${pid}`, kind: 'interactive', entrypoint: 'claude-vscode', status: 'idle', ...extra }));
const readSession = (pid) => JSON.parse(fs.readFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), 'utf8'));

fs.writeFileSync(path.join(claudeDir, 'ide', '1.lock'), JSON.stringify({ pid: 100, workspaceFolders: ['d:\\Work\\Alpha'], ideName: 'Visual Studio Code', authToken: 'SECRET' }));
fs.writeFileSync(path.join(claudeDir, 'ide', '2.lock'), JSON.stringify({ pid: 999, workspaceFolders: ['d:\\Dead'], ideName: 'Visual Studio Code', authToken: 'SECRET' })); // dead window
writeSession(201, { cwd: 'd:\\Work\\Alpha' });                                 // off
writeSession(202, { cwd: 'D:/Work/Alpha/sub', bridgeSessionId: 'session_abc' }); // already on
writeSession(203, { cwd: 'd:\\Elsewhere' });                                    // off, no window
writeSession(204, { cwd: 'd:\\Work\\Alpha', entrypoint: 'cli' });               // terminal session
writeSession(999, { cwd: 'd:\\Gone' });                                          // dead process

// ---- fake extension: reacts to changes of the key only
const events = [];
let known;
const readKey = () => {
  try { const v = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).remoteControlAtStartup; return typeof v === 'boolean' ? v : undefined; } catch { return known; }
};
known = readKey();
const watcher = setInterval(() => {
  const now = readKey();
  if (now === known) return;
  events.push(`${known}->${now}`);
  known = now;
  if (now === undefined) return;
  for (const f of fs.readdirSync(path.join(claudeDir, 'sessions'))) {
    if (!f.endsWith('.json')) continue;
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'sessions', f), 'utf8'));
    if (s.entrypoint !== 'claude-vscode') continue;
    if (now === false && s.bridgeSessionId) { delete s.bridgeSessionId; events.push(`disabled ${s.pid}`); }
    if (now === true && !s.bridgeSessionId) s.bridgeSessionId = `session_${s.pid}`;
    fs.writeFileSync(path.join(claudeDir, 'sessions', f), JSON.stringify(s));
  }
}, 100);

const logs = [];
const core = createCore({ claudeDir, backupDir: path.join(root, 'bak'), log: (m) => logs.push(m), processImages: async () => procs });

(async () => {
  let scan = await core.scan();
  assert.strictEqual(scan.windows.length, 1, 'dead window ignored');
  assert.strictEqual(scan.windows[0].sessions.length, 2, 'two sessions attach to Alpha (201, 202)');
  assert.strictEqual(scan.orphans.length, 1, 'session 203 has no window');
  assert.strictEqual(scan.others.length, 1, 'terminal session reported separately');
  assert.strictEqual(scan.vscodeSessions.length, 3, 'dead pid ignored');
  assert.deepStrictEqual(scan.vscodeSessions.filter((s) => !s.remote).map((s) => s.pid).sort(), [201, 203]);

  // case 1: settings.json absent
  let r = await core.enableAll({ waitMs: 5000 });
  assert.ok(r.ok, r.message);
  assert.strictEqual(readSession(201).bridgeSessionId, 'session_201');
  assert.strictEqual(readSession(203).bridgeSessionId, 'session_203');
  assert.strictEqual(readSession(202).bridgeSessionId, 'session_abc', 'existing bridge untouched');

  // case 2: key already true, new session appears -> must clear then set; never pass through false
  writeSession(201, { cwd: 'd:\\Work\\Alpha', bridgeSessionId: 'session_201' });
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'sonnet', remoteControlAtStartup: true, permissions: { allow: ['x'] } }, null, 2));
  await new Promise((r) => setTimeout(r, 300));
  events.length = 0;
  procs.set(205, 'claude.exe');
  writeSession(205, { cwd: 'd:\\Work\\Alpha' });
  r = await core.enableAll({ waitMs: 5000 });
  assert.ok(r.ok, r.message);
  assert.deepStrictEqual(events.filter((e) => e.includes('->')), ['true->undefined', 'undefined->true']);
  assert.ok(!events.some((e) => e.startsWith('disabled')), 'no session was switched off');
  assert.strictEqual(readSession(205).bridgeSessionId, 'session_205');

  // case 3: other settings preserved, backup written
  const final = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(final.model, 'sonnet');
  assert.deepStrictEqual(final.permissions, { allow: ['x'] });
  assert.ok(fs.readdirSync(path.join(root, 'bak')).length >= 1, 'backup written');

  // case 4: corrupt settings.json is never overwritten
  procs.set(206, 'claude.exe');
  writeSession(206, { cwd: 'd:\\Work\\Alpha' });
  fs.writeFileSync(settingsFile, '{ not json');
  r = await core.enableAll({ waitMs: 1000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), '{ not json');

  // case 5: nothing to do
  fs.writeFileSync(settingsFile, '{}');
  writeSession(206, { cwd: 'd:\\Work\\Alpha', bridgeSessionId: 'session_206' });
  r = await core.enableAll();
  assert.strictEqual(r.message, 'Nothing to do');

  // secrets never logged
  assert.ok(!logs.join('\n').includes('SECRET'));

  console.log('all core tests passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(() => { clearInterval(watcher); fs.rmSync(root, { recursive: true, force: true }); });
