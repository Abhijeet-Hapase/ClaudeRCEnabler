# Claude RC Enabler

Windows tray app that switches on **Remote Control** for every Claude Code session running in your open
VS Code windows that doesn't have it yet.

## Run
- Packaged: `npm run package`, then run `dist\ClaudeRCEnabler-win32-x64\ClaudeRCEnabler.exe`
- From source: `npm install`, then `npm start`
- Tests: `npm test`

Closing the window hides it to the tray. Tray menu: dashboard, "Enable now", auto-enable, start with Windows.

## How it works
Nothing is typed into VS Code and no Claude process is touched. The Claude Code VS Code extension watches
`~/.claude/settings.json` in every window; when `remoteControlAtStartup` *changes* it applies the new value to that
window's running sessions (this is the "Enable Remote Control for all sessions" toggle). Sessions that are already
connected are left alone.

To trigger that for sessions that are off, the app: backs up settings.json, removes `remoteControlAtStartup`,
waits ~1.5 s, sets it to `true`, then waits for each session file in `~/.claude/sessions/` to gain a
`bridgeSessionId`. It never passes through `false`, because that would switch Remote Control **off** for
sessions that have it.

Side effect: `remoteControlAtStartup` stays `true`, so new sessions also start with Remote Control on.

## Limits
- Only sessions started by the VS Code extension (`entrypoint: claude-vscode`). Sessions in a terminal
  (`claude` CLI) or the Claude desktop app are listed but can't be switched on from outside; use `/remote-control`.
- A project's `.claude/settings.json` with `remoteControlAtStartup: false`, or an admin `disableRemoteControl`,
  wins. Those sessions show "Couldn't enable" after 3 automatic tries.
- Relies on undocumented behaviour of the extension and the `~/.claude/sessions` / `~/.claude/ide` file formats
  (checked against extension 2.1.295). A future update could change them.
- Backups of settings.json are kept in `%TEMP%\claude-rc-enabler-backups` (last 10).
- The `*.key` files in `~/.claude/sessions` and the auth tokens in `~/.claude/ide/*.lock` are never read.
