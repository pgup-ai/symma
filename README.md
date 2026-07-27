# symma

Connect a chat surface to a coding agent running on **your own machine**, with
your own credentials.

Every comparable project is one deployment that owns the agent, its login and its
working directory — users get separate conversations against a shared machine.
symma routes each chat user to _their_ laptop instead: their agent, their
subscription, their keys. The hosted service never holds a provider credential.

> Named after the Greek _symmachia_, alliance. Pronounced **SIM-uh**.

## Status

Design, no code yet. The platform is being extracted from
[pgup-ai/jbot-review](https://github.com/pgup-ai/jbot-review), where the relay,
companion, signed envelopes and viewer have been running and dogfooded since
2026-07.

## Planned packages

| package            | what it is                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `@symma/protocol`  | ACP framing, JSON-RPC peer, session driver, agent specs, envelope signing, relay control types |
| `@symma/gateway`   | relay, journal store, viewer, tenancy                                                          |
| `@symma/companion` | attach loop, agent detection, local spawn/lifecycle, self-update                               |
| `@symma/client`    | dial a gateway: config, readiness, transport                                                   |
| `@symma/slack`     | the Slack bot                                                                                  |

`symma` (unscoped) is the companion's install path.

## Design

[`docs/design/m3-slack-companion.md`](docs/design/m3-slack-companion.md) — tenancy,
pairing, conversation model, approval boundary, launch phases, extraction plan.
