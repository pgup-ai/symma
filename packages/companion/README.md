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
machine's identity, writes it to `~/.local/share/symma-companion/` at `0600`,
and leaves a login service behind. `symma install` starts it — after that it
comes back on its own at every login and you never run it again.

|                     |                                                                        |
| ------------------- | ---------------------------------------------------------------------- |
| `symma pair <CODE>` | trade a code from Slack for this machine's identity                    |
| `symma install`     | start the login service, now and at every login                        |
| `symma status`      | whether it is running, what it would reach, which agents are logged in |
| `symma uninstall`   | stop it and remove the service                                         |
| `symma`             | attach in the foreground — what the service runs                       |

Only one at a time: an attach replaces whichever came before it, so a
foreground `symma` alongside the service leaves the two taking the connection
off each other. `symma status` says which is running.

## Agents

Detected automatically — whichever are logged in attach, and pairing names the
rest with what to run to add them: `claude` (via `claude-agent-acp`), `codex`,
`cursor`, `devin`, `gemini`, `kilo`, `opencode`. Any other ACP binary runs via
`SYMMA_COMPANION_AGENTS=name=cmd args`.

## What it does not do

A closed laptop is not running anything, and no supervisor changes that. The
login service covers reboots and crashes; sleep is reported as presence rather
than worked around.
