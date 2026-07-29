# symma

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/pgup-ai/symma)

Connect a chat surface to a coding agent running on **your own machine**, with
your own credentials.

Every comparable project is one deployment that owns the agent, its login and its
working directory — users get separate conversations against a shared machine.
symma routes each chat user to _their_ laptop instead: their agent, their
subscription, their keys. The hosted service never holds a provider credential.

> Named after the Greek _symmachia_, alliance. Pronounced **SIM-uh**.

## Status

Being extracted from
[pgup-ai/jbot-review](https://github.com/pgup-ai/jbot-review), where the relay,
companion, signed envelopes and viewer have been running and dogfooded since
2026-07. The protocol, gateway, companion and client packages are in; the Slack
bot and the tenancy model that M3 needs are not.

## Packages

| package            | what it is                                                                                     | status                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `@symma/protocol`  | ACP framing, JSON-RPC peer, session driver, agent specs, envelope signing, relay control types | [on npm](https://www.npmjs.com/package/@symma/protocol) |
| `@symma/client`    | drive a prompt against a local agent, or a remote one through a gateway                        | [on npm](https://www.npmjs.com/package/@symma/client)   |
| `@symma/gateway`   | relay, journal store, viewer, tenancy                                                          | private — ships as an image                             |
| `@symma/companion` | attach loop, agent detection, local spawn/lifecycle, self-update                               | private — installs as `symma`                           |
| `@symma/slack`     | the Slack bot                                                                                  | planned                                                 |

`symma` (unscoped) is the companion's install path.

## Supported agents

The companion detects every built-in at start — logged in on the machine it
attaches, and pairing names what it skipped and why:

`kilo` · `codex` · `devin` · `cursor` · `claude` (via the ACP registry's
`claude-agent-acp`) · `gemini` · `opencode`

Any other ACP binary runs untiered via `SYMMA_COMPANION_AGENTS=name=cmd args`.

## Design

[`docs/design/m3-slack-companion.md`](docs/design/m3-slack-companion.md) — tenancy,
pairing, conversation model, approval boundary, launch phases, extraction plan.

[`docs/strategy/open-core.md`](docs/strategy/open-core.md) — what gets published,
what stays closed, and what we charge for. Thinking, not decided.
