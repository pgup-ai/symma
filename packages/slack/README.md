# @symma/slack

The bot. Holds one outbound WebSocket to Slack, answers `/connect`, turns a
mention into a private conversation, and picks up replies in that conversation's
DM thread.

It spawns nothing and holds no agent credentials — it asks the gateway to mint a
pairing code for whoever ran the command, and the member runs `symma pair` on the
machine they want to reach.

## Setup

**1. Create the app.** api.slack.com/apps → _Create New App_ → _From a manifest_,
and paste [`app-manifest.json`](app-manifest.json). It asks for `commands` to run
the slash command, `app_mentions:read` to hear a mention, `channels:history` and
`groups:history` to read the thread it came from, `im:history` to hear a reply in
the DM, `mpim:history` so a pasted link into a group DM can be fetched, `channels:read`
with `groups:read`, `im:read` and `mpim:read` to answer whether a link is one the
member could have opened themselves before fetching it — a link resolves only
where the bot is in that conversation too, since it cannot read, or even see,
one it was never added to — `chat:write` with `im:write` to answer there, and `reactions:write`
to mark their message while a run is out. A shared answer goes out as the bot
with the approving member named in front — Slack decides authorship by token
type, and the bot token is the only one this app posts with. **Re-paste it after a
change and reinstall**, or the new scopes are not granted.

**2. Make an app-level token.** _Basic Information_ → _App-Level Tokens_ →
_Generate_, with the `connections:write` scope. This is the `xapp-…` token Socket
Mode dials with. The `xoxb-…` bot token is separate and also needed now — reading
a thread and posting a DM are authorized calls, where `/connect` got by on
`response_url` carrying its own.

**3. Install it** to the workspace, and note the team id (`T…`).

Slash commands and the messages tab are granted at install. A command added to
the manifest _after_ an install is not in the workspace until you reinstall,
which reads as `/connect is not a valid command` — the app config listing it is
not the same as the workspace having it.

**4. Run it** beside the gateway:

```bash
SYMMA_SLACK_APP_TOKEN=xapp-… \
SYMMA_SLACK_BOT_TOKEN=xoxb-… \
SYMMA_SLACK_TEAM=T0123ABCD \
SYMMA_GATEWAY=https://gateway.symma.dev \
SYMMA_SLACK_GATEWAY_TOKEN=… \
npm run slack
```

`SYMMA_SLACK_GATEWAY_TOKEN` must equal the gateway's `SYMMA_GATEWAY_BOT_TOKEN`.
Unset there, `/api/slack/pair` does not exist and every `/connect` reports that
symma could not be reached.

## Why no public URL

Socket Mode delivers commands over an outbound WebSocket, so the bot needs no
TLS site, no event endpoint and no OAuth — which is the whole reason the pilot
runs on a custom app. The trade is that Socket Mode apps cannot be listed in the
Slack Marketplace; that is a deliberate phase-1 choice, not an oversight.

`SYMMA_SLACK_BUDGET_BYTES` caps injected thread context (24 kB by default). It is
a ceiling, not a tuning knob: over it, the snapshot keeps the root and the newest
replies and says how many it left out.

## Scope

One slash command, deliberately. A chat surface that grows model, provider,
directory and shell controls is support and security surface this workflow has
not earned yet — mentions are the interface, not commands.

A mention supplies context and a destination — never an answer. Work happens in
the member's DM, and nothing returns to the channel without an explicit grant:
the answer carries a _Share to thread_ button, and pressing it is the only way
it leaves (§5).
