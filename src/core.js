'use strict';
/**
 * Core logic: find live Claude Code sessions in VS Code windows and switch Remote Control on.
 *
 * How enabling works (no UI automation, no touching the Claude processes):
 *   The Claude Code VS Code extension watches ~/.claude/settings.json in every window. When the
 *   `remoteControlAtStartup` key changes it applies the new value to that window's *running*
 *   sessions: sessions that are disconnected get Remote Control switched on, sessions that are
 *   already connected are left alone. The extension only reacts to a *change*, so we remove the
 *   key first (a no-op for sessions) and then set it to true.
 *
 *   Never go false -> true here: the intermediate `false` would switch Remote Control OFF on
 *   sessions that already have it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SETTING_KEY = 'remoteControlAtStartup';
const EXTENSION_DEBOUNCE_MS = 1500; // the extension debounces file events by 200ms; leave headroom
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isInside(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  return !!p && (c === p || c.startsWith(p + '\\'));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** pid -> lowercase image name for every running process (one tasklist call). */
function listProcessImages() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      const map = new Map();
      for (const line of out.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line);
        if (m) map.set(Number(m[2]), m[1].toLowerCase());
      }
      resolve(map);
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function createCore(opts = {}) {
  const claudeDir = opts.claudeDir || defaultClaudeDir();
  const backupDir = opts.backupDir || path.join(os.tmpdir(), 'claude-rc-enabler-backups');
  const log = opts.log || (() => {});
  const settingsFile = path.join(claudeDir, 'settings.json');
  const sessionsDir = path.join(claudeDir, 'sessions');
  const ideDir = path.join(claudeDir, 'ide');

  // ---------------------------------------------------------------- scanning
  async function scan() {
    const images = opts.processImages ? await opts.processImages() : await listProcessImages();
    const alive = (pid, allowed) => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      if (images) {
        const img = images.get(pid);
        return !!img && (!allowed || allowed.some((a) => img === a));
      }
      return pidAlive(pid);
    };

    // VS Code windows, from the IDE lock files (only the folders are read; auth tokens are ignored).
    const windows = new Map();
    let lockFiles = [];
    try {
      lockFiles = fs.readdirSync(ideDir).filter((f) => f.endsWith('.lock'));
    } catch {}
    for (const f of lockFiles) {
      const lock = readJson(path.join(ideDir, f));
      if (!lock || !Array.isArray(lock.workspaceFolders)) continue;
      if (!alive(lock.pid, ['code.exe', 'code - insiders.exe', 'cursor.exe', 'windsurf.exe', 'codium.exe'])) continue;
      const folders = lock.workspaceFolders.filter((x) => typeof x === 'string');
      const key = folders.map(normPath).sort().join('|') || `pid:${lock.pid}`;
      if (!windows.has(key)) {
        windows.set(key, {
          id: key,
          ide: lock.ideName || 'VS Code',
          folders,
          title: folders.length ? folders.map((x) => path.basename(x)).join(', ') : '(no folder)',
          sessions: [],
        });
      }
    }

    // Claude sessions, from ~/.claude/sessions/<pid>.json (the *.key files hold secrets and are never read).
    const sessions = [];
    let sessionFiles = [];
    try {
      sessionFiles = fs.readdirSync(sessionsDir).filter((f) => /^\d+\.json$/.test(f));
    } catch {}
    for (const f of sessionFiles) {
      const s = readJson(path.join(sessionsDir, f));
      if (!s || !alive(s.pid, ['claude.exe', 'node.exe', 'bun.exe'])) continue;
      const inVsCode = s.entrypoint === 'claude-vscode';
      sessions.push({
        pid: s.pid,
        sessionId: s.sessionId,
        name: s.name || String(s.sessionId || s.pid).slice(0, 8),
        cwd: s.cwd || '',
        entrypoint: s.entrypoint || 'unknown',
        kind: s.kind,
        status: s.status || 'unknown',
        version: s.version,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        remote: !!s.bridgeSessionId,
        bridgeSessionId: s.bridgeSessionId || null,
        inVsCode,
        // terminal CLI sessions that live in a VS Code integrated terminal are shown but cannot be switched on from outside
        scope: inVsCode ? 'extension' : 'other',
      });
    }

    // attach sessions to windows (longest matching workspace folder wins)
    const orphans = [];
    for (const s of sessions) {
      if (!s.inVsCode) continue;
      let best = null;
      let bestLen = -1;
      for (const w of windows.values()) {
        for (const folder of w.folders) {
          if (isInside(s.cwd, folder) && normPath(folder).length > bestLen) {
            best = w;
            bestLen = normPath(folder).length;
          }
        }
      }
      if (best) best.sessions.push(s);
      else orphans.push(s);
    }

    const win = [...windows.values()].sort((a, b) => a.title.localeCompare(b.title));
    return {
      windows: win,
      orphans,
      others: sessions.filter((s) => !s.inVsCode),
      vscodeSessions: sessions.filter((s) => s.inVsCode),
    };
  }

  // ---------------------------------------------------------------- settings.json
  function readSettingsRaw() {
    try {
      return fs.readFileSync(settingsFile, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  function parseSettings(raw) {
    if (raw === null || raw.trim() === '') return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('settings.json is not a JSON object');
    return obj;
  }

  function writeSettings(obj) {
    const text = JSON.stringify(obj, null, 2) + '\n';
    fs.mkdirSync(claudeDir, { recursive: true });
    const tmp = `${settingsFile}.rcenabler-${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, settingsFile);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      fs.writeFileSync(settingsFile, text);
    }
  }

  function backupSettings(raw) {
    if (raw === null) return null;
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const file = path.join(backupDir, `settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, raw);
      const old = fs.readdirSync(backupDir).filter((f) => f.startsWith('settings-')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 10))) fs.unlinkSync(path.join(backupDir, f));
      return file;
    } catch (e) {
      log(`Could not back up settings.json: ${e.message}`);
      return null;
    }
  }

  function currentSetting() {
    try {
      const v = parseSettings(readSettingsRaw())[SETTING_KEY];
      return typeof v === 'boolean' ? v : null;
    } catch {
      return undefined; // unreadable
    }
  }

  // ---------------------------------------------------------------- enabling
  let running = null;

  /**
   * Switch Remote Control on for every VS Code extension session that has it off.
   * Returns { ok, targets, enabled, failed, message }.
   */
  function enableAll({ reason = 'manual', waitMs = 45000 } = {}) {
    if (running) return running;
    running = (async () => {
      const before = await scan();
      const targets = before.vscodeSessions.filter((s) => !s.remote);
      if (targets.length === 0) return { ok: true, targets: [], enabled: [], failed: [], message: 'Nothing to do' };
      log(`Enabling Remote Control (${reason}) for ${targets.length} session(s): ${targets.map((t) => t.name).join(', ')}`);

      let raw;
      let settings;
      try {
        raw = readSettingsRaw();
        settings = parseSettings(raw);
      } catch (e) {
        const message = `Cannot read ${settingsFile}: ${e.message}. Left untouched.`;
        log(message);
        return { ok: false, targets, enabled: [], failed: targets, message };
      }

      const backup = backupSettings(raw);
      if (backup) log(`Backed up settings.json -> ${backup}`);
      const previous = Object.prototype.hasOwnProperty.call(settings, SETTING_KEY) ? settings[SETTING_KEY] : '(absent)';
      log(`${SETTING_KEY} was ${JSON.stringify(previous)}`);

      try {
        if (previous !== '(absent)') {
          // 1) clear the key. The extension treats this as "no preference" and does not touch any session.
          delete settings[SETTING_KEY];
          writeSettings(settings);
          await sleep(EXTENSION_DEBOUNCE_MS);
        }
        // 2) set it to true. The extension now switches Remote Control on for every disconnected session.
        const latest = parseSettings(readSettingsRaw()); // re-read in case Claude Code rewrote the file meanwhile
        latest[SETTING_KEY] = true;
        writeSettings(latest);
      } catch (e) {
        const message = `Failed to update settings.json: ${e.message}`;
        log(message);
        return { ok: false, targets, enabled: [], failed: targets, message };
      }

      // 3) wait for the sessions to report a bridge id
      const deadline = Date.now() + waitMs;
      let after = before;
      let pending = targets;
      while (Date.now() < deadline) {
        await sleep(1500);
        after = await scan();
        const byPid = new Map(after.vscodeSessions.map((s) => [s.pid, s]));
        pending = targets.filter((t) => {
          const now = byPid.get(t.pid);
          return now && !now.remote; // sessions that exited meanwhile are no longer pending
        });
        if (pending.length === 0) break;
      }
      const pendingPids = new Set(pending.map((p) => p.pid));
      const enabled = targets.filter((t) => !pendingPids.has(t.pid));
      const failed = pending;
      const message = failed.length
        ? `Enabled ${enabled.length}/${targets.length}. Still off: ${failed.map((f) => f.name).join(', ')}`
        : `Remote Control enabled for ${enabled.length} session(s)`;
      log(message);
      return { ok: failed.length === 0, targets, enabled, failed, message };
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return { claudeDir, settingsFile, scan, enableAll, currentSetting, isRunning: () => !!running };
}

module.exports = { createCore, normPath, isInside, SETTING_KEY };
