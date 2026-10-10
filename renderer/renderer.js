'use strict';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function chip(s, busy) {
  if (s.remote) return el('span', 'chip on', 'Remote Control on');
  if (busy) return el('span', 'chip busy', 'Enabling…');
  if (s.gaveUp) return el('span', 'chip bad', "Couldn't enable");
  return el('span', 'chip off', 'Remote Control off');
}

function sessionRow(s, busy) {
  const row = el('div', 'sess');
  row.appendChild(el('div', 'name', s.name));
  row.appendChild(chip(s, busy));
  const bits = [`pid ${s.pid}`, s.status];
  if (s.version) bits.push(`v${s.version}`);
  if (s.gaveUp) bits.push('tried 3 times; a project setting may opt out, or type /remote-control in the session');
  row.appendChild(el('div', 'sub', bits.join(' · ')));
  return row;
}

function render(st) {
  if (!st) return;
  const busy = st.busy;
  const vs = st.vscodeSessions;
  const off = vs.filter((s) => !s.remote).length;
  $('summary').textContent = vs.length
    ? `${vs.length - off} of ${vs.length} VS Code sessions have Remote Control on` + (off ? ` · ${off} off` : '')
    : 'No Claude Code sessions are running in VS Code';
  $('enable').disabled = busy || off === 0;
  $('enable').textContent = busy ? 'Enabling…' : off ? `Enable Remote Control now (${off})` : 'All sessions are on';
  $('auto').checked = !!st.config.auto;
  $('login').checked = !!st.login;

  const r = st.lastResult;
  const banner = $('result');
  if (r && r.targets.length && Date.now() - r.at < 120000) {
    banner.hidden = false;
    banner.className = 'banner ' + (r.ok ? 'ok' : 'bad');
    banner.textContent = r.message;
  } else banner.hidden = true;

  const host = $('windows');
  host.replaceChildren();
  for (const w of st.windows) {
    const card = el('section', 'win');
    card.appendChild(el('h2', null, w.title));
    card.appendChild(el('div', 'path', w.folders.join(' · ')));
    if (w.sessions.length === 0) card.appendChild(el('p', 'empty', 'No Claude Code session in this window.'));
    for (const s of w.sessions) card.appendChild(sessionRow(s, busy));
    host.appendChild(card);
  }
  if (st.orphans.length) {
    const card = el('section', 'win');
    card.appendChild(el('h2', null, 'Other VS Code sessions'));
    card.appendChild(el('div', 'path', 'Sessions whose folder matches no open window'));
    for (const s of st.orphans) card.appendChild(sessionRow(s, busy));
    host.appendChild(card);
  }
  if (!st.windows.length && !st.orphans.length) host.appendChild(el('p', 'empty', 'No VS Code windows with the Claude Code extension were found.'));

  $('otherBox').hidden = st.others.length === 0;
  $('otherSummary').textContent = `${st.others.length} other session(s) not managed here`;
  const oth = $('others');
  oth.replaceChildren();
  for (const s of st.others) {
    const row = el('div', 'sess');
    row.appendChild(el('div', 'name', s.name));
    row.appendChild(el('span', 'chip ' + (s.remote ? 'on' : 'off'), s.remote ? 'Remote Control on' : 'Remote Control off'));
    row.appendChild(el('div', 'sub', `${s.entrypoint} · pid ${s.pid}`));
    oth.appendChild(row);
  }

  const v = st.setting;
  $('setting').textContent = `Setting remoteControlAtStartup: ${v === undefined ? 'unreadable' : v === null ? 'not set' : v}`;
}

const logEl = $('log');
function addLog(line) {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

$('enable').addEventListener('click', () => window.rc.enableNow());
$('auto').addEventListener('change', (e) => window.rc.setAuto(e.target.checked));
$('login').addEventListener('change', (e) => window.rc.setLogin(e.target.checked));
$('openLog').addEventListener('click', () => window.rc.openLog());

window.rc.on('init', ({ logs, state }) => { logEl.textContent = ''; logs.forEach(addLog); render(state); });
window.rc.on('state', render);
window.rc.on('log', addLog);
window.rc.on('busy', () => { $('enable').disabled = true; $('enable').textContent = 'Enabling…'; });
window.rc.refresh();
