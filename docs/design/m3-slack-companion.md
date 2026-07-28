# symma M3 — Slack ↔ personal companion

- **Date:** 2026-07-27
- **Status:** design, no code
- **Builds on:** `2026-07-24-acp-gateway-m2-design.md` (M2a–M2d shipped and dogfooded)

## The bet

A Slack user runs a companion on their own laptop. The bot routes their messages
to **their** agent, with **their** credentials, on **their** machine.

### The category exists; the identity model does not

Surveyed **2026-07-26**. Every project below connects Slack to _an_ ACP agent.
None of _these_ routes each Slack actor to that person's separately
authenticated machine — but the survey was incomplete, see below.

Star counts and repo status drift, so treat them as a snapshot of that date, not
a fact. Before citing this table again, re-check the repos and record URLs and
commit SHAs alongside the claims.

| project                            | what matches                                                                                                                                 | how it differs                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **cc-connect** (~14.4k★)           | most mature local bridge: Socket Mode, any ACP agent, local credentials, streaming, permissions, per-user session keys                       | one deployment owns the machine, working directory, agent login and credentials. Private session state, **not** personal agent ownership |
| **OpenAB** (~712★)                 | Rust ACP broker, native Slack, thread-per-session, many agent adapters, uses Slack's native agent streaming                                  | deployment-owned: one config + credential set per bot/pod. "Multiple agents" means multiple deployments                                  |
| **OpenACP** (~427★)                | self-hosted Slack/Discord/Telegram bridge, native ACP, approval buttons                                                                      | explicitly single-user; repo status uncertain (404s during the check)                                                                    |
| **slack-acp**                      | thread → ACP session, local stdio agent, throttled streaming; actively updated                                                               | single deployment. Permissions auto-approved behind allowlists                                                                           |
| **Hoomanity**                      | ACP relay for Slack/Telegram/WhatsApp, in-chat tool approvals                                                                                | conversation-centric, single installation                                                                                                |
| **seam-acp**                       | architecturally closest: ACP over authenticated WebSockets to a pre-authenticated remote machine, outbound-only tunnels, session restoration | Discord only so far; remote profiles are operator-configured, not bound to chat identities                                               |
| **OpenHands Agent Canvas** (~225★) | local agent server, Claude Code/Codex over ACP                                                                                               | its Slack path is a cron automation that posts a final result, not a live client                                                         |
| **Juan**                           | "Slack as ACP Client", Socket Mode                                                                                                           | archived March 2026, single machine                                                                                                      |

**The survey missed the largest player, and it does route per user.** Added
2026-07-28 after this section had already been written against the table above.

| project             | what matches                                                                                                                                                                                                                                        | how it differs                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LobeHub** (~81k★) | `lh connect` is an outbound-dial daemon on the user's machine that spawns local agent CLIs (claude-code, codex, amp) and strips ambient provider keys so each uses its own subscription. Slack and Discord channels, device presence, pairing codes | routing is a per-user _preference_ (`AgentDeviceOverride` overriding `boundDeviceId`) layered on a shared agent, and `requestedDeviceId` on a request wins outright |

So the claim this section was built on — that nobody routes Alice to Alice's
laptop and Bob to Bob's — **is false.** LobeHub does, through per-user overrides
merged into a shared agent config, with `RequestTrigger.Bot` upgrading a `local`
target to `device`.

The shape the _rest_ share still holds: one shared agent identity, machine,
credentials and workspace, with isolated conversations per user. A shared Mac
mini is the natural deployment. But "nobody has built personal routing" is no
longer the thing to say.

### So the differentiator is not "ACP agent in Slack"

That has been built several times, and since LobeHub, so has personal routing.
What is left is narrower and better:

> Ownership is the routing rule, not a setting on top of it. An endpoint belongs
> to `(workspace_id, slack_user_id)`, and there is no configuration in which
> Alice's invocation reaches Bob's laptop.

The distinction is worth being precise about, because "we route per user" is now
a thing to say _second_. LobeHub routes per user by letting each user override a
shared agent's bound device; the authorization question — may this sender use
that device — is a separate `canUseDevice` check beside it, and an explicit
`requestedDeviceId` on a request wins outright. In §1's model the two are the
same question: `openSession` refuses when `caller.owner !== endpoint.owner`, so a
request naming someone else's endpoint has nothing left to fall back on.

That is a security posture rather than a feature, which makes it harder to
demo and harder to copy back out of.

What still follows from it:

- Alice and Bob invoke _different_ personal agents in the same thread.
- No workspace-wide shared agent credentials.
- **Provider credentials and local auth files never leave the companion.**
- Presence and capacity are per user.
- Permissions are authorized by the endpoint owner, not whoever controls a channel.

The third bullet is deliberately narrow. "We never see your code" would be false:
relayed frames carry prompts, output and reasoning, and we store them. The
credential is what stays on the machine — see Data lifecycle.

Nor is it uniquely ours: LobeHub strips `ANTHROPIC_API_KEY` from its spawned
CLIs for the same reason `codex.ts` and `kilo.ts` do here — so the agent falls
back to the user's own subscription instead of a stray ambient key. Two
independent arrivals at the same non-obvious fix is evidence it is a real
hazard, not a nicety.

ACP does not solve this layer — it is point-to-point. Routing, reconnection and
ownership are gateway responsibilities. **The defendable product is the
multi-user identity and rendezvous layer, not the Slack bot or the ACP bridge.**

That is also the security work: owner-scoped endpoints are simultaneously what
makes personal routing safe and what makes it a product.

## What M2 already gives us

Not restating M2; this is what M3 inherits and must not break.

- Outbound-only companion, relay with resume windows, signed envelopes (M2d),
  read-only floor in three layers, journal + viewer.
- Multi-agent is already in the protocol: `hello.agents[]` advertises, and
  `OpenControl.agent` / `.model` select per session.
- Agent detection already exists: `resolveAgent` checks each built-in's
  credential path and returns a per-agent reason when it is absent.
- Dogfooded end to end 2026-07-27 (run 30235271632).

**Invariants that carry over unchanged:** auxiliary sessions fail open;
compromise means shutdown, not mitigation; in-band attestation only points
downward. The read-only floor carries over for the review path and is
deliberately lifted for the DM path — §4, "Read-only ends where the caller
changes".

## 1. Tenancy — the load-bearing change

### Today it is single-tenant by construction

|               | today                                                  | why it breaks with two users                                             |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| client auth   | one shared `SYMMA_GATEWAY_TOKEN`                       | any client can open a session on **anyone's** companion                  |
| endpoint auth | per-endpoint tokens from `SYMMA_GATEWAY_ENDPOINTS` env | cannot issue per user without editing the box                            |
| viewer auth   | same shared token                                      | anyone with the link reads every journal — code and full agent reasoning |

The sharp one: `relay.openSession` checks the endpoint is online, has capacity,
and offers the agent. **It never checks the caller is entitled to that
endpoint.** Name someone else's endpoint in the open control and you run an
agent on their laptop, in their checkout, with their credentials.

Correct for one operator. Disqualifying for a Slack bot.

### Target model

Every endpoint has an **owner**: `(workspace_id, slack_user_id)`. Every client
token is scoped to an owner. Three enforcement points:

1. `openSession` refuses when `caller.owner !== endpoint.owner`.
2. Journal reads filter by owner.
3. Endpoint listing shows only the caller's own endpoints.

**Owner is assigned at pairing, never declared by the companion.** A
companion-declared owner is attacker-controlled input — the same mistake as
trusting `dir` or `endpoint` on an envelope, which M2d already had to unlearn.

### Store

Postgres from the start (decided 2026-07-27). Minting tokens needs durable
state, and journals move into a real store too, so the file-based interim would
be thrown away within one milestone.

```
workspaces   (id, slack_team_id, install_kind, installed_at, bot_token_ref)
users        (id, workspace_id, slack_user_id)
endpoints    (id, user_id, device_name, agents[], workspaces[], max_sessions,
              public_key, last_seen_at, protocol_version)
tokens       (id, endpoint_id | user_id, kind, hash, expires_at, revoked_at)
pairings     (code_hash, user_id, expires_at, consumed_at, attempts)

conversations   (id, user_id, dm_channel_id, root_thread_ts,
                 source_channel_id, source_thread_ts,
                 endpoint_id, agent, model, workspace_id, created_at)
turns           (id, conversation_id, slack_event_id UNIQUE, delivery_mode,
                 status, result_ref, published_channel, published_ts)
conversation_sessions (conversation_id, session_id, ordinal, resume_kind)

sessions     (id, endpoint_id, agent, model, status, started/ended)
frames       (session_id, seq, ts, dir, sig, payload)     -- or blob + metadata
```

Tokens and pairing codes stored hashed. `pairings` is single-use, short-TTL, and
counts `attempts` so a guessable code cannot be brute-forced.

**Delivery is a state machine, not a boolean.** Per turn:
`private → post_when_ready → posted | cancelled`, advanced atomically, with the
authorization bound to one user, one turn, and one **immutable** destination
captured at invocation. A turn that has reached `posted` can never post again.

**Everything Slack-facing needs an idempotency key.** The Events API retries
deliveries and interactions must be acknowledged within seconds, so a reconnect
or a slow ack must not create a second DM conversation or publish a second public
answer. `turns.slack_event_id` is unique for that reason; button clicks key on
their action id, and publication keys on `(turn_id, destination)`.

`conversation_sessions.resume_kind` records `exact` vs `recovered`, so the
recovered-resume rule in §4 is a stored fact rather than a UI guess.

### Data lifecycle

The service processes and stores selected Slack context, prompts, agent output
and reasoning — which can contain source code. That has to be stated, defaulted,
and enforced:

|              | position                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| retention    | frames expire on a default window (start at 30 days); the row is the unit, so this is a delete query |
| deletion     | a user can delete a conversation and its frames from the DM                                          |
| uninstall    | removing the Slack app deletes that workspace's conversations, turns, tokens and frames              |
| user removal | deactivating a Slack user revokes their tokens and unpairs their endpoints                           |
| encryption   | at rest via the database; secrets (tokens, pairing codes) stored hashed, never plaintext             |
| logs         | redact prompts, output and tokens — logs carry ids and outcomes, not content                         |
| training     | never. No model training, no fine-tuning, no human review of customer content                        |

M2 deferred retention on a files-and-cron argument. In a store it stops being an
ops chore and starts being a product promise, so it lands with M3a.

## 2. Pairing and onboarding — the product

The beta targets non-technical people, so this flow _is_ the product. Every
surveyed competitor requires building a Slack app, copying tokens, editing
config, and keeping a daemon alive. cc-connect has the best of them and still
needs: create app → scopes → enable Socket Mode → app token → event subscriptions
→ install → copy bot token → paste both → keep running.

**The bar: one workspace install, one local command, no fields to fill in.**

1. The app reaches the workspace. **Which mechanism depends on the phase** (§6):
   the pilot is a custom Socket Mode app the operator installs; OAuth and
   **Add to Slack** belong to the multi-workspace beta. Do not read step 1 as
   OAuth-from-day-one.
2. A member DMs the bot and clicks **Connect my agent**. The gateway mints a
   single-use, short-TTL pairing code bound to `(team_id, user_id)`, with
   per-user and per-IP attempt throttling and a hard attempt cap.
3. On the machine where their agents are already logged in, the member runs the
   installer, which pairs as part of the same run — one line, not two:

   ```
   curl -fsSL https://symma.dev/install.sh | sh -s -- pair FROG-2481-QK7M
   ```

   The code is display-chunked but high-entropy (≥64 bits). Short codes are only
   safe behind throttling, and throttling alone is a weak place to put the whole
   guarantee.

4. The companion detects locally authenticated ACP agents, dials out, exchanges
   the code for a durable endpoint token, persists it `0600`, installs a login
   service, and attaches.
5. **The endpoint id is derived, never typed.** M2 has the operator choose it
   (`laptop`), which is one more field in a flow whose bar is zero fields — and
   it changes when someone reinstalls, orphaning the endpoint the gateway knows.
   Derive it from the machine id, with a per-install connection id beside it so
   two companions on one machine stay distinguishable. Borrowed from LobeHub's
   `lh connect`, which does exactly this. The **device label** stays free text
   ("Jingbo's MacBook Pro") because that one is for humans.
6. The gateway records
   `(team_id, user_id) → owner → companion devices`, plus the member's default
   device and agent. **Provider credentials never enter Slack or the gateway.**
7. The DM shows the selected agent and live presence, with controls to switch
   default, add a device, disconnect, or revoke a lost one. Presence needs no new
   machinery — `/api/endpoints` already reports `online`, agents and free
   capacity; it only needs scoping per user.

Slack confirms with what detection already produced:

> ✅ Connected — Jingbo's MacBook Pro · devin, cursor
> ⚪ codex available — run `codex login` to add it

That second line is free: `resolveAgent` already returns a per-agent reason for
everything it skipped. **Detection output is the onboarding copy.**

**Success criterion:** an ordinary member never creates a Slack app, copies a
bot or app token, edits config, exposes a port, or uploads a provider
credential. If no personal endpoint is online the bot says so and offers to
reconnect — it never runs the request on someone else's machine.

### Failure modes, all of which need words not stack traces

| case                        | behaviour                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| code expired / already used | "That code expired — run **Connect my agent** for a new one."                                                                                                                                                                                                                |
| no agents detected          | install links for supported agents; do not attach an endpoint with zero agents                                                                                                                                                                                               |
| laptop sleeps or closes     | name it as sleep, not failure, and hold the request for wake instead of refusing — never a silent hang. Both need §3 "Staying attached"; today `openSession` refuses and the bot has no way to tell sleep from anything else. **Expect this to be the top support issue.**   |
| companion killed            | **the least distinguishable case, not the most.** SIGTERM with a live session sends a close today; SIGKILL, a crash and an idle exit send nothing, so they read exactly like sleep. §7's goodbye control is what separates them. The login service restarts it at next login |
| two devices                 | both attach; member picks a default, per-session override available                                                                                                                                                                                                          |

## 3. Companion

- **Auto-detect all supported agents.** Change the default agent list from
  `kilo` to every built-in; the resolve loop already skips unauthenticated ones
  with a reason. Roughly a one-line change.
- **Two distribution paths, both supported.** `curl | sh` is primary because 3
  of 4 agent CLIs already install that way (devin via Homebrew, cursor-agent and
  codex via their own installers); those users may have no Node at all. `npx
symma` is secondary for the Node crowd and nearly free from the same codebase.
- **`versions/<v>/` + `current` symlink**, copying codex and cursor-agent. Gives
  atomic upgrade and rollback.
- **Self-update on start.** Not a nicety: external companions cannot be upgraded
  by us, and without self-update every protocol change compounds into a
  permanent compatibility tax.
- **Login service** — launchd user agent on macOS, systemd user unit on Linux.
  "Keep this terminal open" is where non-technical users fall off. See
  "Staying attached" below for why it is a _user_ service and what it cannot
  cover.

**`curl | sh` plus self-update is a supply-chain boundary, so it needs the
supply-chain treatment.** We are asking non-technical people to run our script
and then letting it replace its own binary forever after:

- Release artifacts are **signed**; the installer and the updater verify a
  signature and checksum before swapping `current`. An unverifiable artifact is
  refused, never installed "just this once".
- The installer runs **unprivileged** — user-level paths and a user login
  service, no root, no system-wide daemon.
- The update channel is pinned to a release feed we control and published over
  HTTPS; self-update never follows a redirect to another host.

**Key lifecycle stops being deferred here.** M2 deferred rotation with the
trigger "revisit when a companion is shared or long-lived" — M3 companions are
long-lived by definition, so the trigger has fired:

- The companion's **public key is bound at pairing** and pinned to that endpoint.
- **Revoke** from the DM invalidates the endpoint token and unpins the key.
- **Re-pair replaces** the key rather than adding one, so a lost laptop cannot
  keep signing after it is revoked.
- **Re-pair is confirmed in the DM, not silently by holding a code.** LobeHub's
  pairing mode does this well: the requester gets a code and the _owner_ approves
  it from the chat surface they are already in (`/approve <code>`). Their reason
  is a shared bot needing per-user access control, which §1's ownership model
  makes moot — but the shape transfers to the case that is genuinely dangerous
  here. Replacing a signing key is how a stolen laptop gets cut off, and it is
  also how an attacker with one pairing code would cut _the owner_ off. First
  pair is code-only; **replacing an existing key needs a confirmation in the
  owner's DM.**

Invariant 11 already says compromise means shutdown and token rotation, which is
not a thing you can honour without a rotation path.

### Staying attached

Two halves, and only one of them is solvable. Supervision is packaging. Sleep is
physics, and pretending otherwise is how this becomes the top support issue §2
already predicts.

**The service is a _user_ service, and that is load-bearing.** On macOS a
launchd **LaunchAgent**, not a LaunchDaemon; on Linux a systemd **user** unit
with `loginctl enable-linger` as a deliberate opt-in, not a system unit. The
whole premise is that the agent runs on the machine's ambient auth — kilo's
`auth.json`, `~/.codex`, the login keychain. A root daemon starting before login
cannot see any of it, and a design that reaches for one has quietly decided to
put credentials somewhere else.

The consequence is worth stating rather than engineering around: **the companion
runs while its owner is logged in.** Log out and it stops. That is the same
boundary that keeps the credentials on the machine, seen from the other side.

`RunAtLoad` plus `KeepAlive` covers crash and reboot. Everything below that is
already built and needs no M3 work: the companion reconnects with exponential
backoff (1s→30s, reset on success) and both legs hold a 60s resume window, so a
wifi blip does not kill an in-flight review.

**A closed laptop is not running anything.** No supervisor changes that. The two
technical escapes both lose: clamshell dictates the member's desk, and a
standing power assertion cooks the battery of a machine in a bag. So the product
surface is **presence, not uptime** — and the work is that `online: false` is one
word for situations a member experiences as completely different things.

| what the relay sees                    | what the member is told                  |
| -------------------------------------- | ---------------------------------------- |
| attached                               | ready                                    |
| deliberate goodbye                     | "quit on your Mac — reopen or reconnect" |
| silent drop, inside the resume window  | nothing; it is already coming back       |
| silent drop, past it, last seen 4m ago | "asleep — this will run when it wakes"   |
| never paired, or revoked               | the pairing copy from §2                 |

Two of those rows do not exist yet — the goodbye and the last-seen — and the gap
is smaller than it looks.
`shutdown()` sends a `close` per live session, so a SIGTERM mid-review is
visible — but that is the narrowest case in the set. An _idle_ SIGTERM, which is
the common quit, sends nothing; SIGKILL and a crash never reach the handler at
all; and sleep suspends the process rather than signalling it, so nothing can be
inferred from the companion's side under any of them. All four arrive as the
same silent drop.

One control frame on the way out separates the deliberate exits (§7). A
last-seen timestamp on the relay's attachment covers the rest — it cannot tell a
crash from a lid closing, and does not need to: both mean "not there now, try
later", which is the only thing the member has to act on.

Cheap, and it buys the difference between "something is broken" and "your laptop
is asleep" — which is the entire support burden.

**Queue instead of refusing.** Today `openSession` refuses when the endpoint is
offline. For a member who typed a request and shut the lid, refusing is the
wrong answer to the right question: hold the request and run it on wake. This is
the change that turns §2's predicted top issue into a non-event, and it is not
free — the held request carries a prompt, so it is member content and takes the
same tenancy scoping and retention rules as everything else in §1's store. Bound
it with a TTL and a per-user cap, and put the TTL in the copy ("I'll run this
when your Mac is back, up to 24h") rather than leaving it implicit.

**One narrow power assertion, scoped to a live session** — `caffeinate -i` on
macOS, an inhibitor on Linux, held only while a session is open. The failure it
prevents is a review dying halfway because the screen locked, which reads as our
bug rather than as a sleeping laptop. A blanket assertion is the thing people
uninstall.

**Not building:** wake-on-LAN, or a "keep my laptop awake" toggle. Both spend the
member's hardware to paper over a boundary that is honest. Anyone who genuinely
wants 24/7 runs the same companion on a desktop or VPS — multiple devices
already attach, and §2 step 7 already has the default-device picker.

## 4. Conversation model — one DM thread = one conversation

The private DM is not one endless chat. Each top-level DM thread is one durable
conversation, matching the model users already know from agent apps.

- **Every** mention in a channel thread — public or private — creates a **new**
  DM root and a new `conversationId`. This holds even when the same member tags
  the bot repeatedly from the same source thread; each invocation is its own
  task. A new top-level DM does the same without source context.
- The context snapshot carries every source-thread message the bot can see up to
  that invocation — authors, timestamps, links, and attachment **metadata**
  (file contents are not fetched in v1). It has a **hard byte budget** (same rule
  as every other injected block): keep the root plus the most recent/relevant
  replies and **state exactly what was omitted**.
- **Slack limits how much of the thread we can even read, and it depends on the
  install phase.** Since 2025-05-29, commercially distributed apps _not_ approved
  for the Marketplace get `conversations.replies` at **1 request/minute and 15
  messages**; internal custom apps keep 1,000 messages at 50+ req/min, and
  Marketplace apps are unaffected. So the pilot reads threads properly and the
  unlisted multi-workspace beta cannot — the rate limit and the Marketplace risk
  in §6 are the same problem twice. Choose deliberately between an internal-only
  pilot, bounded on-demand fetching with an honest "I could only see the last N
  replies", or event-fed caching. **Do not cache whole workspaces to dodge a rate
  limit** — that inflates the data-lifecycle surface for a quota workaround.
- Reading a private channel's thread needs the bot to be _in_ it. When it is not,
  or scopes are missing, say so rather than answering from a partial snapshot.
- Later source-thread messages never silently join a running task. Tagging again
  creates another conversation with a fresh snapshot.
- Every prompt, clarification, progress link, draft, failure and follow-up lives
  under that DM root. Replying in the thread resumes it.
- Durable identity is
  `(team_id, user_id, dm_channel_id, root_thread_ts) → conversationId`, which
  then points at the chosen endpoint, agent, and **current** ACP session. **A
  transient ACP session id is never the user-facing conversation identity.**
- Sharing back to a channel neither closes nor forks the private conversation.
- Channel threads are context sources and share destinations — never session
  owners. Several members can each start their own private conversation from the
  same thread without seeing or steering each other's work.

**Resuming:** route to the live ACP session if it exists; otherwise reattach with
`session/load`. For agents that cannot reload, start a replacement session with a
budgeted recovery context from the durable transcript and **mark the turn as
recovered** — never present an empty session as a true resume. Exact process and
tool state may be gone; typing in an old DM thread must still address the same
conversation.

### Which directory does the agent see?

M2 never had to answer this: the reviewer's companion clones a client-supplied
repo into a temp dir, and with no `repo` the agent gets an empty one. Neither is
right for "ask my agent about this thread" — the user wants their actual project,
and a remotely-supplied filesystem path would be a straight escape out of the
temp dir M2 relies on.

The rule: **the companion advertises, the gateway selects.**

- The companion holds an **allowlist of workspace roots**, configured locally by
  its owner — the only place a real path appears.
- It advertises them as **opaque ids** (`hello.workspaces[]`), never paths.
- `OpenControl` may name only an advertised id. An unknown id is refused, exactly
  like an unoffered agent.
- Per-user default plus a per-conversation picker; the selection is shown in the
  DM root so the answer's scope is never ambiguous.
- **No-workspace mode** for general questions — an empty temp dir, as today.

This is one decision doing two jobs: the picker is the UX, and the allowlist is
the local-filesystem security boundary.

### Read-only ends where the caller changes

M2's floor exists because of _who calls_, not because agents are dangerous: the
reviewer points an agent at an arbitrary PR's code, so mutating tool kinds are
denied, the workspace is a throwaway clone, and credentials are copied into a
per-spawn temp `HOME` that is deleted afterwards. That posture is right for
review and does not change.

The DM path inverts the premise. The caller is the endpoint's own owner, asking
about their own project, on their own machine — and an agent that cannot edit
the file it is discussing is the wrong tool for it.

**The floor is a property of the path, not of the protocol.**

- **Review path** — unchanged: deny `edit`/`delete`/`move`/`write`/`switch_mode`,
  throwaway clone, relocated credentials, `requirePlanMode` failing closed.
- **DM path** — writes allowed, **inside an allowlisted workspace root and
  nowhere else**. The allowlist above is already the local-filesystem boundary;
  write mode reuses it rather than adding a second one. No-workspace mode stays
  read-only — there is nothing there worth writing to.

**The agent runs as itself.** No temp `HOME`, no credential copy. A session
started from Slack lands in the agent's own history (`codex`, `kilo`), so its
owner can resume it locally — and that history is the record of what the agent
did, which a discarded home destroys.

Two consequences to design for rather than around:

- **Sessions serialize per agent.** The temp `HOME` was also what made
  concurrent spawns safe; a shared real home races the agent's own session state
  (kilo keeps a SQLite dir there). Write-mode agents run one session at a time
  until a specific agent is shown to tolerate more.
- **Invocation is not content.** §5's rule has a mirror here: the owner
  authorising a session is not the owner authorising whatever a public thread
  told the agent to do. Only the owner may invoke, but thread contents are
  untrusted input now reaching an agent that can write. The workspace allowlist
  is what bounds that — it is why writes are confined rather than ambient — and
  the agent's own history is what makes them visible afterwards.

Write mode is configured by the companion's owner, per endpoint, in the same
local file as the workspace allowlist. It is never a remote setting, and never
something an `OpenControl` can ask for.

## 5. Approval and delivery — invocation is not consent

The gap in every shipped Slack agent bot, including Codex's and Claude's: tag it
in a public thread and it publishes whatever it produces. No review, no
follow-up, no chance to catch a weak first draft.

> **Invoking the agent is not consent to publish its response.**

A public thread supplies _context_ and a _destination_. The work happens
privately. Immediately after creating the DM conversation the bot offers two
buttons **while the agent already starts working**:

- **Keep private** — the default. Completion produces a private draft for
  review, follow-ups, and an optional **Share to thread**.
- **Post when ready** — a one-turn authorization for the next _successful_ final
  answer to go straight to the source thread. Thinking, tool output, permission
  prompts and partial responses stay private regardless.

Rules:

- No choice ⇒ private. The choice can be changed until publication.
- Clarification, permission request, or failure **cancels** direct delivery and
  keeps the conversation private.
- **Share to thread** previews exact content and destination, and the shared post
  names the member who approved it.
- Sharing does not end the session; later replies can produce a revised share.
- If the destination has become unusable — thread archived, channel locked or
  read-only, bot removed, scope revoked — **keep the answer in the DM** and say
  which of those happened. A publication that cannot land is not a lost answer.
- The bot must never read "the agent produced a final response" as "publish it"
  without an unrevoked authorization for that turn.

This keeps the review gate for substantive work without adding friction to quick
questions.

slack-acp, OpenAB and OpenHands auto-approve permissions behind allowlists —
permissive precisely because their agents can write. On the review path ours
cannot, so nothing there needs approving. The DM path does write (§4), and the
difference from those projects is where the allowlist lives: theirs is a
permission list configured in the bot, ours is the workspace allowlist held by
the companion's owner, so no approval can widen the filesystem an agent reaches.
Requests that would escape it — a write outside an allowlisted root, anything
touching credentials — route to the **endpoint owner** as signed, expiring
decisions instead of being auto-approved.

### Streaming and the Slack surface

- **Reasoning stays in the viewer as a privacy choice, not a rate-limit one.**
  Slack ships `chat.startStream` / `chat.appendStream` / `chat.stopStream` plus native
  task and plan cards for agents, and OpenAB already uses them — so "~1 write per
  second, therefore no streaming" is not a constraint we are under. Slack shows
  acknowledgement, coarse plan/tool progress via native cards, then the final
  answer and a Share action.
- **Agent/model choice:** picker from `hello.agents[]` — cheap, already
  advertised. Model gets a per-agent default plus an optional override; no
  enumeration in v1, since model lists arrive only in `session/new`'s
  `configOptions` and run to hundreds of entries. Add a lazy `models` control
  later only if users ask.

**Shortcut caveat:** a Slack message shortcut invoked from a threaded message
cannot publish back into that thread directly. Persist the originating
`channel` + `thread_ts` at invocation and post normally on share.

## 6. Launch path and distribution risk

**The bot needs no public HTTPS endpoint.** Socket Mode delivers events and
interactive actions over an **outbound WebSocket**, so the bot is outbound-only
and sits beside the gateway. Nearly every local competitor works this way.

The catch is that Socket Mode apps **cannot be listed in the Slack Marketplace**,
which splits the launch into three phases:

| phase                       | install                                      | needs                                                                                   | thread reads                          |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| **1. internal pilot**       | operator installs one custom Socket Mode app | no OAuth, no public endpoint                                                            | full (1,000/req, 50+/min)             |
| **2. multi-workspace beta** | OAuth + **Add to Slack**                     | OAuth infra; distribution policy settled first                                          | **degraded** — 15 messages, 1 req/min |
| **3. public scale**         | Marketplace listing                          | HTTP event + interactivity endpoints (Socket Mode cannot be listed), Marketplace review | full                                  |

Phase 2 is the awkward one: it needs the most new infrastructure and gets the
worst thread access. That is an argument for staying in phase 1 until the
Marketplace question is answered, rather than treating phase 2 as the natural
next step.

**Slack Connect / shared channels are out of scope for the pilot.** An external
member's identity does not belong to the installing workspace, so
`(team_id, user_id) → owner` is not well defined for them. Refuse rather than
guess.

**The biggest product risk is Slack's Marketplace policy**, not the engineering.
Slack's requirements currently reject apps that "enable remote execution on a
server via a downloadable third party script," and flag sharing third-party
service accounts between users. Per-user companions dodge the second problem
cleanly — that is the whole design. The first is a real question: a downloadable
companion that executes commands is close to the described pattern.

Consequences:

- **Do not treat "Slack supplies distribution" as an assumed advantage.** It was
  listed as a reason to pick Slack; it is unproven.
- This likely explains the market shape: successful local projects make every
  customer create and install their own Slack app rather than shipping one
  Marketplace app.
- Get written clarification from Slack before building anything that depends on
  Marketplace listing. Until then, ship the custom-app pilot, which needs none
  of it.

### Architecture (Socket Mode)

```
  ─── Slack ───────    ────── our VPS (one box, Caddy TLS) ──────    ─ Alice's machine ─
  slack.com            bot: NO public URL   gateway.symma.dev        no public address

  SLACK                    BOT                    GATEWAY            COMPANION
 ┌────────────────────┐ ┌───────────────────┐ ┌──────────────────┐ ┌────────────────────┐
 │ #incidents         │ │ Socket Mode       │ │ relay + journal  │ │ Alice's logged-in  │
 │  ⋯ stack trace     │ │ client            │ │ + viewer + authz │ │ agent (devin / …)  │
 │  @symma  ──────────┼▶│                   │ │                  │ │                    │
 │                    │①│ team+user → THAT  │②│ owner check:     │③│                    │
 │                    │ │ user's endpoint   ├▶│ caller == owner? ├▶│ spawn, run, stream │
 │                    │ │ never a shared    │ │                  │ │                    │
 │                    │ │ agent             │◀┤ thinking ⋯ (SSE) │◀┤ thought chunks ⋯   │
 ├────────────────────┤ │                   │ │                  │ └────────────────────┘
 │ DM with @symma     │ │                   │ └──────────────────┘
 │ ▸ new task thread  │◀┤④ new conversation │
 │   [Keep private]   │ │  + delivery ask   │
 │   [Post when ready]│ │                   │
 │   🔗 watch live ───┼─┼───────────────────┼──▶ browser → viewer (owner-scoped)
 │   … quiet …        │ │                   │
 │   ✅ draft         │◀┤⑤ final answer     │
 │   [Share to thread]├▶│⑥ authorized post  │
 └────────────────────┘ └───────────────────┘

  Inbound connections accepted:
    SLACK      — none from us; the bot dials OUT and keeps one WebSocket open
    BOT        — none. No public URL, no Caddy site, no event endpoint
    GATEWAY    — yes: companions dial in, browsers load the viewer
    COMPANION  — none. Outbound only, as in M2

  Bob tags the same thread → ② resolves to BOB's endpoint → his agent, his
  subscription, his machine. Two agents, one context — the thing no competitor
  can express.
```

Why each number matters:

- **①** the mention carries thread context into a _new private_ conversation —
  it is not permission to answer in the channel.
- **②** the actor→owner→endpoint resolution is the entire security model. This is
  the check `relay.openSession` does not do today.
- **③** unchanged from M2 in shape: outbound-dial companion, signed frames. The
  bot holds no agent credentials and spawns nothing. The floor is the one thing
  that differs — writes are allowed inside an allowlisted workspace root (§4).
- **④+⑤** two private writes, so there is no dead air while reasoning stays in
  the owner-scoped viewer — now a privacy choice, not a rate-limit workaround.
- **⑥** requires an explicit grant: **Post when ready** before completion, or
  **Share to thread** after review.

## 7. Protocol changes

1. **`version` on `hello`**, negotiated by the gateway, which serves N and N−1.
   Mandatory before external companions exist: atomic upgrades end the moment a
   companion runs on someone else's laptop. M2d is the cautionary example —
   signing needed both sides, and we simply deployed both.
2. **Owner binding** established during pairing and stored server-side.
3. **A goodbye control** the companion sends as it exits, so the relay can tell
   "quit" from "asleep" (§3, "Staying attached"). Sleep is unsignalable by
   construction — the process is suspended, not notified — so the only way to
   separate the two is for the deliberate exit to say so. Small, but it has to
   ride the same `hello.version` negotiation as everything else here: a relay
   that expects a goodbye from a companion too old to send one is back to
   guessing, and must degrade to the timestamp rather than mislabel.
4. **Relay control types move** into the shared protocol package — **done**,
   `@symma/protocol` `relay-control.ts`. Today `src/companion/` and
   `src/shared/acp-remote.ts` both import from `src/gateway/` — the wire
   protocol lives inside one of its three consumers. The observer envelope
   (`ObserverEnvelope`, `parseEnvelope`) proved to be the same defect one file
   over, in `journal.ts`, with consumers in the gateway, the companion and the
   client; it moved to `@symma/protocol` `envelope.ts` for the same reason.

## 8. Extraction — what moves, and how

### The boundary already exists

Measured 2026-07-27 across the 4,353 lines that would move. Every internal
import the candidate set makes, classified:

| import                                                                                                                | verdict                             |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `acp-protocol.ts`, `envelope-signature.ts`, `relay.ts`, `journal.ts`, `ndjson.ts`, `observer.ts`, `signal-cleanup.ts` | already self-contained — move as-is |
| `cli-process.ts` (process-tree kill), `model.ts` (`parseModelName`)                                                   | generic — move                      |
| `devin.ts`, `codex.ts`, `cursor.ts`, `kilo.ts` (credential paths)                                                     | belong with the agent specs — move  |
| `prompt.ts`, `opencode.ts`, `types.ts`, `text.ts`, `session-concurrency.ts`                                           | review-specific — **stay**          |

**Only `acp.ts` imports the review-specific ones.** That is by design —
`acp-protocol.ts` was written to import nothing review-related, and it held.
`acp.ts` is the `ReviewBackend` adapter; it is jbot-review's file, not symma's.

Two files sit across the seam and split rather than move:

- **`acp.ts`** — the child-process spawn, timeout, and temp-home lifecycle are
  generic (`runLocalAcpPrompt(spec, workspace, prompt, opts) → string`); the
  `ReviewBackend` wrapper that parses findings is not.
- **`acp-remote.ts`** — `RemoteAcpConfig`, `checkEndpointReady`, the SSE
  transport and `runRemotePrompt` are generic; `createRemoteAcpBackend`,
  `gatewayRoutedModels`, `remoteAcpConfigFromEnv` and `localRunId` are
  jbot-review's routing policy and stay.

Also fixed on the way out: `src/companion/` and `src/shared/acp-remote.ts`
currently import `parseRelayControl` from `src/gateway/`. The wire protocol lives
inside one of its three consumers; extraction moves it to `@symma/protocol`,
where all three depend on it equally.

### Package graph

```
@symma/protocol    framing, JSON-RPC peer, driveAcpSession, agent specs +
                   credential helpers, read-only permission floor, envelope
                   signing, observer envelope, relay control types, ndjson
@symma/gateway     relay, journal store, viewer, HTTP API, tenancy   → protocol
@symma/companion   attach loop, agent detection, checkout *mechanism*,
                   local spawn/lifecycle, self-update                → protocol
@symma/client      drive an ACP prompt: local spawn/lifecycle, plus a gateway
                   transport — config, readiness, SSE, runRemotePrompt
                                                                     → protocol
@symma/slack       the bot — dials the gateway like any other client
                                                        → client, protocol
jbot-review        ReviewBackend adapters + routing policy   → protocol, client
```

`@symma/client` is the one jbot-review actually consumes at runtime; it exists so
the reviewer never imports gateway internals to dial a gateway — the inversion
being fixed above, prevented from recurring.

**Mechanism moves, policy stays.** The companion learns _how_ to clone a ref into
a temp dir; it never learns _which_ ref or why. Review-specific repo/ref choice,
the three-dot rule, and the throwaway-checkout policy stay in jbot-review, which
already supplies them as `OpenControl.repo/ref/base`. Same split as the agent
specs: symma owns the capability, the client owns the decision.

### Sequence

**Principle: jbot-review is not touched until symma is fully tested.** It runs
reviews daily and has a deployed App; destabilising it for a refactor that serves
a _different_ product is risk with no upside for it.

That rules out splitting in place, so the boundary gets validated in symma
instead — which works because **the tests travel with the code**: 12 files
(`acp-protocol`, `acp-remote`, `companion-workspace`, `envelope-signature`,
`relay`, `journal`, `gateway`, `ndjson`, `observer`, `signal-cleanup`, and three
`viewer-*`) already cover everything that moves.

1. **Create `pgup-ai/symma`** — README, workspaces, this design doc. Nothing in
   jbot-review changes. **Done.**
2. **Copy the self-contained components in, with their tests.** Green in the new
   repo before anything else happens. **Done.**
3. **Do the `acp.ts` / `acp-remote.ts` split there, not here.** symma takes only
   the generic halves — local spawn/lifecycle, transport, readiness. The
   `ReviewBackend` wrappers and routing policy never leave jbot-review, so this
   is an extraction, not a migration. **Done.**
4. **Publish `@symma/*`**, exact-pinned. Shipped as 0.1.0, then 0.1.1 once
   the barrel was completed, then `@symma/client` 0.2.0 for the tee option
   step 5 needed. Narrowed on contact: only
   `protocol` and `client` are libraries and publish. `gateway` and `companion`
   stay `private` and publish nothing at this step; they are applications, and
   they ship by other routes later — the gateway as an image, the companion as
   unscoped `symma`. `gateway`'s sole export today is a test seam, which is not
   an API worth freezing at 0.1.0.
5. **Only now touch jbot-review:** swap imports to the packages, keeping the
   local files in place. If the suite goes red, revert one import line.
   **Done** — jbot-review#125 took `@symma/protocol`, #126 took `@symma/client`.
6. **Cross-repo compatibility green → delete the originals.** Deleting earlier
   turns a packaging mistake into a bisect across two repositories. **Done** —
   jbot-review#127, 1318 lines, one commit.

**Divergence was the cost of this order.** Two copies existed between steps 2 and
6, so jbot-review's were frozen for that window and any fix that could not wait
landed in symma first and was re-copied — never the reverse, or the extraction
would have inherited drift. The window is closed for `protocol` and `client`:
jbot-review holds no copy, and a fix reaches it as a release plus a pin bump
there, since the pins are exact and publishing alone moves nothing.

It is still open for `gateway` and `companion`, and this is the part the six
steps do not cover. They publish nothing, so there was no step 5 to swap
jbot-review onto them and no step 6 to delete what it kept running. Both copies
are live and they have drifted — symma's `server.ts` gained a cross-run frame
guard, a fail-open journal write and a `q=0`-aware `acceptsGzip` that
jbot-review's has not — which is the exact failure this order was meant to
bound, just deferred rather than avoided. Publishing them is what closes it.

Step 3 was expected to be the whole risk. It was not — see the status note
below.

**Status — 2026-07-27. Step 2 is complete.** `@symma/protocol` (#1), then
`@symma/gateway` and `@symma/companion` (#2), 43 tests green. `viewer.ts` copied
byte-identical; every other copied file differs from its origin only by an
import line, plus the spawn paths the new layout requires. The M2 gateway design
now lives here too, as [`m2-acp-gateway.md`](m2-acp-gateway.md) — a spec left
behind would have died with the code it describes, which step 6 deleted.

The runtime graph holds: companion depends on protocol alone. It reaches
`@symma/gateway` only as a devDependency, because its end-to-end test spawns a
real gateway and reads back what was journaled.

**Step 3 is done as of #3** — `@symma/client`, 48 tests green. `runLocalAcpPrompt`
and the remote transport moved; every `ReviewBackend` factory, `gatewayRoutedModels`,
`remoteAcpConfigFromEnv` and `localRunId` stayed, exactly as this section drew the
line. `EndpointPresence` moved to protocol on the way out: the gateway builds it
and the client reads it, so it was a wire type inside one consumer, like the relay
controls and the observer envelope before it.

**Step 3 was not the risk this section expected, and the reason matters.** The
"whole risk" verdict was measured at file level — `acp.ts` imports five
review-specific modules. At symbol level the generic half uses exactly one of the
fifteen names they contribute (`truncateForLog`, already in protocol),
`session-concurrency` is a type-only import used solely by the factories that
stay, and `acp-remote` needs `acp.ts` only for the factory that stays. The seam
was drawn correctly when the code was written; cutting it was mechanical.

**`observer.ts` probably does not belong here at all.** The table above lists it
as "move as-is", but that table classifies files by what they _import_, and
observer.ts imports nothing — which is exactly why it looks portable. Its
callers tell the opposite story, and they are all review-side: `runner.ts` takes
`setRunName`/`reportRun`/`closeObserver`, and `reportRun` is the jbot verdict
rather than a protocol event; `local/index.ts` takes `observerEnabled` and
`setRunName`. The one caller that could have moved — `makeSessionTee` inside
`driveAcpSession` — was deleted in #1 when the tee became injectable. Inside
symma the parameter's caller is now `runLocalAcpPrompt`.

Nor does the product need it: the gateway _receives_ `/api/ingest`, and the
companion sends over its relay leg, which the gateway journals directly.
Nothing in the Slack↔companion path tees to that endpoint; its senders are
jbot-review's tee and the demo feeder. Step 5 settled it: the import swap wanted
nothing here. `observer.ts` stayed, and jbot-review builds the tee at its own
call site and injects it.

Step 3 is therefore complete.

**Step 4 is done as of #5.** `@symma/protocol` and `@symma/client` are on the
public npm registry under the `symma` org, MIT, installable. `gateway` and
`companion` stay private. `tsc` emits JS and `.d.ts`; sources import each other
as `./foo.js`, and the workspace resolves to source through the `symma-source`
export condition while consumers get `dist`. `npm run verify:pack` is the only
check that loads the packages the way a consumer does — everything else runs
inside the workspace, where source resolution hides packaging faults.

### What step 5 actually cost

The readiness audit compared every symbol jbot-review imports against what the
package exports, and found the barrel 28 names short — the per-agent provider
ids, CLI binaries and credential helpers its production code uses. A symbol
exported from its module but absent from `index.ts` is invisible to consumers
however public it looks in source, and only a consumer-shaped check finds that.

Two contract changes needed handling in the same commit as the swap, and only
one of them was loud:

- **The observer tee.** jbot-review built it inside `driveAcpSession`; the
  package takes it injected. Swapping the import alone stopped teeing local ACP
  reviews with no type error and no failing test, because the tee is env-gated
  and off in CI. It stopped being structural the moment it became an argument,
  so jbot-review now pins it with a test.
- **`relayed: true`** failed at typecheck, which is what a contract change
  should do.

`@symma/client` also could not serve its only consumer at 0.1.1:
`runLocalAcpPrompt` had no slot for a tee, so the local runner was unusable by
the one repo adopting it. Fixed in 0.2.0 — a break worth taking while the
package was a day old with a single consumer mid-adoption.

Intra-workspace pins must track the workspace version exactly. `*` resolves to
the registry copy instead of the local one, which silently tests a published
package against workspace source — the failure surfaces as a missing `src/`,
since tarballs ship only `dist`.

**Step 6 landed as jbot-review#127.** Nine source files went first, then two
things the swap had left behind. `relay.ts` still declared the eight relay
control types and `parseRelayControl` beside the identical exported ones —
`server.ts` and `companion/index.ts` had already moved to the package, so the
parser had no caller at all. And four test files (`acp-protocol`,
`envelope-signature`, `ndjson`, `signal-cleanup`, plus relay's parser case) were
_strict subsets_ of symma's: zero cases they had that symma lacked, three that
symma has and they lacked. An old copy of a dependency's unit tests reads as
coverage and is not.

What a consumer keeps instead is the seam it owns. The `codex`/`cursor`/`devin`/
`kilo` tests stay — symma has none, and `devin`/`kilo` reach into jbot-review's
own prompt and config. The read-only floor case moved into `acp-backend.test.ts`
rather than going with the rest: the code is symma's, the guarantee is
jbot-review's invariant #8, and an exact pin means a consumer-side check fires
on the bump that loosens it instead of after the review that wrote to a repo.

### Repo, domains, and the name

**Repo:** `pgup-ai/symma` becomes the platform repository; `jbot-review` stays
put as its first downstream client and reference consumer.

**Domains** — reserve the root for the product, not the gateway:

| host                | serves                                                  |
| ------------------- | ------------------------------------------------------- |
| `symma.dev`         | product, install script, docs                           |
| `app.symma.dev`     | devices, agents, conversations, viewer                  |
| `api.symma.dev`     | OAuth and product API (phase 2+)                        |
| `gateway.symma.dev` | companion connections                                   |
| `status.symma.dev`  | service health — the M2 outage was silent for two hours |

The M2 gateway currently answers on the apex of another domain; splitting it out
now costs a DNS record, later it costs a migration of every paired companion.

**Name:** symma ships as an open-source project. `symma.com` is an unrelated
software consultancy of the same name (checked 2026-07-27); decided 2026-07-27
that this is not a concern and needs no clearance — noted so it is not
rediscovered and re-raised later.

In copy, write "inspired by the Greek _symmachia_, meaning alliance" —
`symma` is a coined shortening rather than the Greek word itself. Pronounced
_SIM-uh_; put that in the README.

### Copy, do not `filter-repo`

History for these files is ~2 weeks old and its value is low against the cost:
jbot-review is public, and its history still carries the pre-hardening content
that the M2 work deliberately stopped re-exporting. A fresh initial commit that
names the origin SHA keeps the provenance without dragging that along.

## 9. Milestones

|         | scope                                                                                                                                                | done when                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M3a** | Postgres + owner-scoped endpoints, tokens, journals, data lifecycle                                                                                  | a second user can neither open a session on, nor list, nor read journals or the viewer for, the first user's companion — all four proven by test, not just `openSession` |
| **M3b** | pairing: codes, `/connect`, token exchange                                                                                                           | a fresh laptop pairs from one command with no config file                                                                                                                |
| **M3c** | companion: auto-detect, dual distribution, self-update, login service, goodbye control                                                               | survives reboot and a closed lid — reattaches on wake untouched; upgrades itself; reports which agents it found and why it skipped others                                |
| **M3d** | Slack (custom app, Socket Mode): DM-thread conversations, turn routing, keep-private/post-when-ready, share-back, agent selection, offline messaging | a non-technical tester completes a task from Slack without help, including one sent to a sleeping laptop — §3's presence copy and queue, not a hang or an error          |

M3d's bar is a person, not a passing test. If a tester needs a hand, the
milestone is not done.

Sequencing note: **three of these are security gates, not one.** M3a is the
first — until owner-scoped access lands, any client can drive any companion, so
do not demo the Slack flow to a second person before it. But weak pairing (M3b)
hands an attacker an endpoint, and an unsigned updater (M3c) hands them every
companion that ever installed. Each needs its own security review before it ships
to anyone outside the operator.

## 10. Open / deferred

- **Model enumeration** in Slack — deferred; needs a `models` control.
- **Write-mode approvals** — the DM path writes inside an allowlisted workspace
  root (§4); what stays open is the escape case, where a request that would
  leave that root becomes a signed, expiring decision for the endpoint owner
  (§5). Not needed for the pilot, since the allowlist already refuses it.
- **Multi-workspace billing** — not modelled.
- **Slack Marketplace listing** — blocked pending written clarification that a
  downloadable companion does not fall under "remote execution on a server via a
  downloadable third party script." The pilot does not need it; a public SaaS
  launch does. Do not build OAuth/public-endpoint infrastructure until answered.
- **Native Slack streaming** (`chat.startStream` and task cards) — available and
  proven by OpenAB, but v1 keeps reasoning in the owner-scoped viewer. Revisit as
  a UX call once the review gate is in place.
- **Org-owned shared endpoints** (a team Mac mini with its own ACL) — an explicit
  future mode, never a fallback when someone's personal endpoint is offline.
- **Attachment contents** — v1 passes metadata only. Downloading files widens both
  the scope request and the data-lifecycle surface; decide deliberately.
- **Viewer scope** (should non-ACP runs appear at all) — unresolved product
  question inherited from M2, sharpened by run 30235271632, where the guideline
  pass ran to completion on the pi engine and appeared nowhere.

**Closed since M2, so do not re-defer them:** key rotation (M2's trigger was "a
companion is shared or long-lived" — M3 companions are long-lived by definition;
ships with pairing, §3) and journal retention (now a retention default in the
data-lifecycle table; ships with M3a).
