# @symma/slack

The bot. Holds one outbound WebSocket to Slack and answers `/connect`.

It spawns nothing and holds no agent credentials — it asks the gateway to mint a
pairing code for whoever ran the command, and the member runs `symma pair` on the
machine they want to reach.

## Setup

**1. Create the app.** api.slack.com/apps → _Create New App_ → _From a manifest_,
and paste [`app-manifest.json`](app-manifest.json). It asks for one scope,
`commands`, because one slash command is all this does today.

**2. Make an app-level token.** _Basic Information_ → _App-Level Tokens_ →
_Generate_, with the `connections:write` scope. This is the `xapp-…` token Socket
Mode dials with — not the bot token, which nothing here needs yet: `/connect`
answers through Slack's `response_url`, which carries its own authorization.

**3. Install it** to the workspace, and note the team id (`T…`).

**4. Run it** beside the gateway:

```bash
SYMMA_SLACK_APP_TOKEN=xapp-… \
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

## Scope

One command, deliberately. A chat surface that grows model, provider, directory
and shell controls is support and security surface this workflow has not earned
yet.
