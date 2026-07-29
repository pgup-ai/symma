# symma

Connects a chat surface to the coding agents already logged in on **your own
machine**, using your own credentials. The hosted service never holds a provider
credential — see [pgup-ai/symma](https://github.com/pgup-ai/symma).

```bash
npm i -g symma
symma pair BPB1-9W92-HTZJ-RA19
```

`npx symma pair …` works too, but installs no login service: npx runs from a
cache that is eventually deleted, and a companion supervised out of one stops
coming back after a reboot without saying so.

Pairing detects the agents you are logged into, exchanges the code for this
machine's identity, and writes it to `~/.local/share/symma-companion/` at
`0600`. Running `symma` with no arguments attaches with what it saved.

## Agents

Detected automatically — whichever are logged in attach, and pairing names the
rest with what to run to add them: `claude` (via `claude-agent-acp`), `codex`,
`cursor`, `devin`, `gemini`, `kilo`, `opencode`. Any other ACP binary runs via
`SYMMA_COMPANION_AGENTS=name=cmd args`.

## What it does not do

A closed laptop is not running anything, and no supervisor changes that. The
login service covers reboots and crashes; sleep is reported as presence rather
than worked around.
