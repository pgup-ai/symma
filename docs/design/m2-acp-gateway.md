# ACP gateway M2 — rendezvous relay + outbound-dial companion — design

- **Status:** M2a–M2d shipped and dogfooded end to end (2026-07-27). Nothing open; retention and key rotation deferred with triggers, viewer scope is a product question. Next milestone is M3.
- **Updated:** 2026-07-26
- **Date:** 2026-07-24
- **Scope:** extend the M1 observer gateway into a pairing relay that routes live
  ACP sessions between thin clients (jbot CI/local) and agent **companions** that
  dial out from wherever the user's agents are already logged in (laptop, VPS,
  cloud). First client: jbot-review with zero provider keys in GitHub.
- **Prior art:** M0 engine (`src/shared/acp.ts`, spec 2026-07-22), M1 observer
  (`src/gateway/*`, `src/shared/observer.ts`, PR #103–#106), live infra at
  `observer.pgupai.com` (Caddy TLS + token, systemd, auto-deploy).

## Goal

A user runs one companion command on the machine where their agents already
work; that machine's ACP agents (kilo/cursor/devin/codex today) become
endpoints reachable through the hosted gateway. jbot's runner drops provider
credentials entirely and drives the same review sessions through the gateway
with a single revocable token. **Credentials never leave the user's machine.**

## Non-goals (M2)

- No multi-tenant org/sharing model, no signup — endpoint tokens are
  operator-configured on the gateway (service-ification is M3, gated on pull).
- No non-ACP cloud-agent adapters; no chat product.
- No event-semantics translation — the relay stays a **dumb pipe** (auth,
  route, journal, fan-out; frames verbatim).
- No general remote-execution offering: MVP companions accept only the
  read-only review session shape jbot uses (bash-for-git allowed, writes
  denied). General execution waits for a hardened sandbox story.

## Background — what the codebase already gives us

1. **The transport seam exists.** `AcpConnection` is constructed over an
   abstract `AcpSessionIo` (`{ input: Writable, output: Readable }`), not a
   child process (`acp-protocol.ts`). Remote = supply a network-backed io pair;
   `driveAcpSession`, permission handling, JSON repair, and parsing are
   untouched. (#117 split the engine out of the review backend so the
   companion/gateway no longer reach the review pipeline at all.)
2. **Framing is settled.** `createNdjsonReader` (32MB frame budget) parses
   newline-delimited JSON-RPC on both ends; the gateway's bounded ingest
   parser (`server.ts handleIngest`) is the server-side twin.
3. **The envelope exists.** `ObserverEnvelope` (`journal.ts`: v, runId,
   sessionId, seq, ts, agent, label, model?, dir, frame) is already the thin
   wrapper the plan called for; M2 adds a sibling control envelope.
4. **Journal + viewer come free.** The relay sees both directions of every
   session, so it journals them in the exact M1 format — the existing viewer
   renders relayed sessions with zero changes, and the M1 tee becomes
   redundant for remote sessions (it stays for in-process ones).
5. **Deploy story exists.** `deploy/observer/` (systemd + Caddy + scoped
   deploy user + path-filtered auto-deploy) extends to the grown gateway
   unchanged; the companion reuses the same unit pattern on user boxes.

## Architecture

```
  ─ GitHub runner / your laptop ─   ──── our VPS: observer.pgupai.com ────   ─ user's own machine (or their VM) ─
    ephemeral, no public address       the ONLY public host, Caddy TLS          no public address, dials out

   CLIENT  (CI runner / laptop)        GATEWAY  (VPS, the only public host)        COMPANION  (laptop / VPS / cloud)
 ┌────────────────────────────┐      ┌──────────────────────────────────┐      ┌──────────────────────────────────┐
 │ runner.ts                  │      │ Caddy  TLS ──▶ 127.0.0.1:8790    │      │ companion/index.ts               │
 │  routes ACP providers to   │      │ server.ts   routes + token auth  │      │  dials OUT — NO listening port   │
 │  the gateway when          │      │ relay.ts    pairing, presence,   │      │ acp-protocol.ts                  │
 │  JBOT_ACP_GATEWAY_* set    │      │             ownership, resume    │      │  *AcpSpec() → spawns the CLI     │
 │ acp-remote.ts              │      │ ndjson.ts   bounded line parser  │      │  deny-floor (writes refused)     │
 │  createRemoteAcpBackend    │      │ journal.ts  NDJSON transcripts   │      │ per-session temp workspace       │
 │  → AcpSessionIo over HTTP  │      │ viewer.ts   live SSE viewer      │      │ git clone repo@ref (own auth)    │
 │ acp-protocol.ts            │      │                                  │      │                                  │
 │  driveAcpSession (shared)  │      │ ✗ no agents  ✗ no agent creds    │      │ ✓ HOLDS the agent credentials    │
 └─────────────┬──────────────┘      └────────────────┬─────────────────┘      └────────────────┬─────────────────┘
               │                                      │                                         │
               │  ① GET  /api/sessions/:sid/stream    │    ③ GET  /api/endpoints/:id/stream     │
               │     (SSE ↓ agent frames, controls)   │       (SSE ↓ opens, client frames)      │
               ├─────────────────────────────────────▶│◀────────────────────────────────────────┤
               │  ② POST /api/sessions/:sid/ingest    │    ④ POST /api/endpoints/:id/ingest     │
               │     (NDJSON ↑ open, prompts)         │       (NDJSON ↑ hello, acks, frames)    │
               └─────────────────────────────────────▶│◀────────────────────────────────────────┘
                                                      │
                        browser ◀── SSE ──────────────┘  /api/runs, /api/endpoints, viewer
```

**Every connection is dialed _outbound to the gateway_** — by the client _and_
by the companion. Neither needs an open port or NAT config; the gateway is the
only host with a public address. Outbound dial is not one-way: the companion's
SSE leg (③) is how opens and client frames arrive _inbound_ to the laptop.

|                              | Client             | Gateway           | Companion           |
| ---------------------------- | ------------------ | ----------------- | ------------------- |
| Has agent credentials        | no                 | **no**            | **yes**             |
| Has the repo                 | its own checkout   | no                | clones per session  |
| Spawns agent processes       | only in local mode | **never**         | yes                 |
| Auth it presents             | client token       | — (verifies both) | per-endpoint token  |
| Survives the other's restart | resume window      | drains on SIGTERM | reconnect + backoff |

## Transport: HTTP stream pair (decided), not wss

Each peer (companion or client) holds two connections per attachment:

- **Down:** one long-lived `GET …/stream` (SSE, `data:` lines) — the proven
  M1 path through Caddy (`flush_interval -1`), heartbeats included.
- **Up:** one streaming `POST …/ingest` (NDJSON, `duplex: 'half'`) — the
  proven `observer.ts` pattern, parsed by the same bounded line parser.

Rationale: zero new dependencies (repo rule; the README's "no websocket
library" stays true), both halves are already implemented and
production-tested end to end, and reconnect/resume semantics (seq + journal
replay + dedupe) already exist in the viewer and generalize. Revisit wss only
if we later need sub-frame latency or binary frames; nothing in ACP does.

**Delivery semantics — the one place M2 must differ from M1:** the observer
tee is drop-ok (fail-open telemetry). Relayed session frames are
**must-deliver**: a dropped `session/prompt` result corrupts the session.
Per-connection buffers stay bounded (ByteLength, same 64MB class), and
overflow **fails the session loudly** — never a silent drop. Fail-open stays
the rule for the observer tee only.

**Resume, not just fail (in the v1 wire format):** connection loss ≠ session
loss. Peers hold bounded replay buffers keyed by seq; the journal doubles as
the gateway's ack log (an appended frame is a delivered-to-gateway frame).
On reconnect the peer sends a `lastSeq` cursor per session and the missing
range replays from journal + edge buffers, deduped by seq — the exact M1
viewer mechanism, made bidirectional. A session fails loudly only when a peer
stays gone past the resume window (default 60s) or a replay buffer overflows.
M2a ships the resume _window_ (agent survives a companion blip; loud failure
past it); the cursor replay lands in M2b as an additive field — the control
parser ignores unknown keys, so no wire break. Motivation is concrete, not
hypothetical: our own path-filtered auto-deploy restarts the
gateway on every gateway-code merge, and laptop companions sleep/roam
constantly — churn is the _normal_ case for a local-agent bridge. The
gateway also drains on SIGTERM (finish relaying buffered frames, close
cleanly) so a deploy is a sub-second blip inside the resume window.

## Wire protocol (thin envelopes, frames verbatim)

Control messages (new, `kind`-discriminated like `RunControl`):

- companion → gateway: `{kind:'hello', endpoint, device, agents:[{agent,
model?}...], maxSessions}` on connect; presence is the connection itself.
  `device` is a free-text indicator ("macbook-pro", "jbot-vps") surfaced in
  `/api/endpoints` and the viewer, so flat endpoint ids stay ergonomic.
- client → gateway: `{kind:'open', endpoint, agent, sessionId, repo?, ref?}`;
  gateway relays to companion, which acks `{kind:'opened'| 'refused', reason?}`.
- either: `{kind:'close', sessionId, reason?}`.

Session frames: the existing envelope with `dir` relative to the agent
(`out` = client→agent), `frame` = raw JSON-RPC, `seq` per (sessionId, sender).
The gateway validates ids (`isSafeId`), enforces size caps (48MB line cap
already above the 32MB ACP budget), journals, and forwards — it never
interprets `frame`.

## Gateway changes (`src/gateway/`)

- New routes (same process, same auth style):
  - `GET /api/endpoints/:id/stream` + `POST /api/endpoints/:id/ingest` —
    companion attachment, authed by **per-endpoint token** (new
    `JBOT_GATEWAY_ENDPOINTS` config: `id:token` pairs, env or file; MVP is
    operator-managed, no signup).
  - `GET /api/sessions/:sid/stream` + `POST /api/sessions/:sid/ingest` —
    client side, authed by the existing gateway token.
  - `GET /api/endpoints` — presence + advertised agents for clients/viewer.
- In-memory router: `endpointId → attachment`, `sessionId → {clientConn,
endpointId}`; on either side dropping, fail open sessions per the delivery
  rule. Extract `handleIngest`'s line parser into a shared helper (it gains a
  second caller); journal writes reuse `appendEnvelope` unchanged.
- Viewer: unchanged for transcripts; add endpoint presence to the run list
  later (nice-to-have, not M2-blocking).

## Companion (new `src/companion/`, bundled like the gateway)

- Single binary (`node dist/companion/index.js`), config = env:
  `JBOT_COMPANION_GATEWAY` (url), `JBOT_COMPANION_TOKEN`,
  `JBOT_COMPANION_ENDPOINT` (id), `JBOT_COMPANION_AGENTS` (csv of enabled
  agents). Reuses the existing `kiloAcpSpec`/`codexAcpSpec`/… from
  `shared/acp-protocol.ts` — with **ambient auth**: no key materialization; the specs'
  env indirection reads the user's real `~/.codex`, kilo auth, etc.
- Per `open`: fetch `repo`@`ref` with the companion's **own git/gh auth**
  (credential portability cuts both ways) into a throwaway dir
  (`mkdtemp`, rm on close — same hygiene as acp.ts temp homes); spawn the CLI
  via the existing spec; bridge child stdio ↔ gateway stream pair.
- **Security floor (day one, non-negotiable):**
  - Permission deny-floor **companion-side**: the client still answers
    `session/request_permission`, but the companion independently applies
    `respondToPermissionRequest`'s deny-list (write/edit/patch/delete/move/
    switch_mode) and refuses grants the floor forbids — a malicious client
    must not be able to authorize writes on the user's machine.
  - Env scrub: children get the spec's env only, never the companion's full
    environment beyond what each `*AcpSpec` already whitelists.
  - Session-shape gate: MVP accepts only plan-mode/read-only sessions.
  - Concurrency cap: `maxSessions` enforced locally (plain counter; the
    session-concurrency machinery stays runner-side where fan-out lives).
- Reconnect with backoff, resuming in-flight sessions from seq cursors
  within the resume window (Delivery §); the spawned agent process stays
  alive through gateway loss. Loud failure only past the window.

## jbot client integration (`src/shared/`)

- `createRemoteAcpBackend(gateway, token, endpoint, agent, workspace):
ReviewBackend` — same return type as `createAcpBackend`, so
  `runner.ts` wiring is one extra branch per provider: when
  `JBOT_ACP_GATEWAY_URL/TOKEN/ENDPOINT` are set and the selected provider is
  ACP-capable, build remote instead of spawning locally. Everything above the
  backend (prompts, parsing, verdicts, concurrency, fan-out) is untouched.
- Context assembly stays runner-side (it owns the diff/guideline budgets and
  the checkout the Action already made); the companion's checkout serves the
  **agent's own exploration** (git grep/log during the session). Same ref on
  both sides.
- CI thin-client mode: workflow env carries only the three `JBOT_ACP_GATEWAY_*`
  values (secrets) — zero provider keys in GitHub. Presence policy: if the
  chosen endpoint is offline, fail the run with a clear error in M2; the
  "fall back to in-runner keys" hybrid is a follow-up flag, not MVP.

## Packaging (in-repo now, extract at M3)

**Done (#117):** `acp-protocol.ts` now holds the engine with zero review
imports, so the extractable unit is `acp-protocol + gateway + companion` and
extraction is a `git mv` plus a package.json rather than an untangling.

Relay + companion still stay **in this repo**: publishing freezes
the wire format, so the envelope and control protocol must survive real
dogfood first. The trigger is now sharper — **the first non-you user installing the
companion**. At that point they
extract as scoped packages — `acp-relay` (gateway) + `acp-companion`, or one
package with two bins — with the envelope + control protocol as the semver'd
public contract and jbot-review as the reference consumer. That extraction
coincides with the buzz-style identity keys, so the published surface is
multi-tenant-shaped from its first release rather than retrofitted. Until
then, keeping the code beside its first consumer is what lets the protocol
change cheaply.

## Implementation status (2026-07-25)

| Milestone                                                                            | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PR   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| **M2a** relay + companion                                                            | **shipped**, acceptance met live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | #107 |
| gateway `requestTimeout` hotfix                                                      | **shipped**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #108 |
| clone shallow-race flake                                                             | **shipped**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #110 |
| **M2b** remote ACP backend + runner routing                                          | **shipped**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #109 |
| **M2c** CI thin client + preflight                                                   | **shipped**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #116 |
| protocol/backend split (extraction prerequisite)                                     | **shipped**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #117 |
| **M2b dogfood** — real `review:local` through a live companion                       | **done** 2026-07-27                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —    |
| **M2c dogfood** — CI review through a live companion                                 | **done** 2026-07-27, run 30235271632: `Backend routing: main=devin aux=pi`, `ACP gateway: routing devin to laptop`, one session on the companion. Earlier CI runs only _looked_ routed — a journal proves the tee fired, not that a companion served it; `session/new` cwd is what distinguishes them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —    |
| dogfood finding: relayed sessions journaled twice                                    | **fixed** — with `JBOT_OBSERVER_URL` and the gateway both pointed at one host, a routed review landed twice (run 30234095772: `review` and `review-b9a96d4e`, 6833 frames each, same workspace and second). The client tee is off for relayed sessions; its copy was the worse one — unsigned, no endpoint, and double the journal bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | #123 |
| **M2d** signed envelopes                                                             | **shipped** — companion-signed, viewer check, offline verifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | #119 |
| dogfood fixes: clone depth, relay fan-out, committed-HEAD diff, signal-safe teardown | **shipped**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #118 |
| viewer: bulk journal endpoint, in-gateway gzip, render batching                      | **shipped**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #120 |
| viewer escaping guard (parse + source rule + delimiter behaviour)                    | **shipped**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #121 |
| key rotation                                                                         | **deferred** — one key per companion, replaced by deleting `signing-key.pem`; revisit if a companion is ever shared or long-lived enough to warrant it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —    |
| **M2e** client-served workspace                                                      | **rejected** — 3 of 4 agents ignore client capabilities (spike 2026-07-25)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —    |
| repo-reachability preflight                                                          | **dropped** 2026-07-27 — the premise ("fails at the first session, after model spend has started") does not hold: the companion refuses at clone failure _before_ spawning the agent, the refusal carries git's own error, and that session spends nothing. A control-channel probe across three deployed components would buy sibling shards a few seconds. Scoping it surfaced the real defect instead — the clone ran on `spawnSync`, freezing every other session on that companion                                                                                                                                                                                                                                                                                                                            | #123 |
| depth-1 clone: deepen or not                                                         | **resolved** — depth 50 plus deepen-to-merge-base, base SHA carried on the open control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | #118 |
| observer sees only ACP runs                                                          | **by design, not a defect** — 69 of 75 run dirs hold a `status` file and no `.ndjson` because those reviews ran on the pi engine (`Backend routing: main=pi aux=pi`, verified on run 30225222211). The tee emits ACP frames; a pi/opencode review has none. The verdict still lands, so the run stays listed. Sharpest example, run 30235271632: main on the companion is visible, while the guideline pass ran to completion on `engine=pi` and appears nowhere — so **absence from the viewer says nothing about whether a pass ran**; the run log does. It bites per-session, not just per-run, because `--provider`/`--model` set main only and aux comes from repo vars (`/jbot` and `workflow_dispatch` expose no aux flags). Open _product_ question: whether the viewer should show non-ACP reviews at all | —    |
| journal retention                                                                    | **deferred** 2026-07-27 — still true that nothing prunes `/var/lib/jbot-gateway` and that frames hold full agent reasoning, but the volume does not justify code yet: 7 of 82 runs carry a journal at all (the rest are non-ACP), the largest ~9MB, and #123 stopped routed runs writing every frame twice. Interim lever is operational — a `find -mtime +N -delete` cron on the box. Revisit when traffic is sustained or a second tenant appears, at which point it belongs with the Postgres/listing work in M3 rather than as a bolt-on                                                                                                                                                                                                                                                                       | —    |

**M2a acceptance, live:** a companion on a MacBook attached to
`observer.pgupai.com` over TLS; a real kilo session streamed 34 thought
chunks, a websearch tool call, and the final answer — 57 frames journaled.
Gotcha found only by running it: a client must drain after `stopReason` or
kilo's trailing frames are lost (`driveAcpSession` does; hand-rolled clients
must too).

**What the M2b dogfood proved** (journals on `observer.pgupai.com`, none of it
covered by an automated test):

- **The companion's `git clone repo@ref` path** — `repo`/`ref` are never set in
  tests; live, sessions open in `…/T/jbot-companion-XXXXXX` and the agent reviewed
  real code out of it.
- **Concurrent sessions against one endpoint** — three live at once
  (`review-5e2e006b`, `review-3eb037e9`, `guideline-compliance-a977581c` all
  overlapping 17:54:21–17:54:26), ~10k frames interleaved, each session's journal
  cleanly separated.
- **Review-sized prompts** — 6362 and 5703 frames over 4 and 7 minutes.

**M2c, proven separately** (run 30235271632). It did not follow from the above:
every journaled CI run before it (`pr-107`, `pr-115`, `pr-119`) opened with
`cwd: /github/workspace`, because a journal existing only means the tee fired,
not that a companion served the session. The distinguishing artifact is
`session/new`'s cwd — a `jbot-companion-*` dir — and the run log's
`ACP gateway: routing devin to laptop`. Worth keeping as method: when one
component has two roles (relay and observer), pick acceptance evidence only the
role under test can produce.

**What it surfaced** — `kilo/kilo-auto/free` twice returned `stopReason: end_turn`
with `inputTokens: 0, outputTokens: 0`: once on a `guideline-compliance` pass (failed
open, as invariant 3 requires) and once on a main-shard `-retry`, which reran on the
same model and died identically 4 seconds later. Upstream behaviour, not a gateway
defect — but the shard retry (`runner.ts:2506`, "one retry … for ANY failure")
treats a zero-token refusal like a dropped stream, so that shard's findings are just
lost. Decide separately from M2.

**Found and fixed during M2c review** (worth keeping as precedent): the
preflight originally keyed on `mainCliBackend ?? auxCliBackend ?? ''`, so a
gateway configured alongside a non-ACP provider aborted an otherwise-valid
local review. A guard whose scope is wider than the thing it guards is worse
than no guard.

## M2e — client-served workspace (REJECTED 2026-07-25: agents don't honor it)

The idea: advertise `fs.readTextFile` + `terminal` in `clientCapabilities` and
serve files/commands **from the client**, so the companion needs no repo at
all. The runner is better positioned for anything git — full history
(`fetch-depth: 0`), already holds the GitHub token, sees uncommitted work.

**Measured instead of assumed.** Spike: advertise both capabilities, give the
agent an **empty** cwd, ask it to read a file only the client can serve
(`/tmp/acp-spike`, real binaries, real auth):

| Agent     | called `fs/read_text_file` | got the served file | what it did instead                                   |
| --------- | -------------------------- | ------------------- | ----------------------------------------------------- |
| **devin** | **1**                      | **yes**             | — (honors the capability)                             |
| kilo      | 0                          | no                  | own `read` → "the file does not exist"                |
| cursor    | 0                          | no                  | own `Read File`, `Find`, then shelled `pwd && ls -la` |
| codex     | 0                          | no                  | own read, then `rg --files -g 'SECRET.md'`            |

**Three of four ignore the advertisement**, and cursor/codex fall back to
_shell_ commands — so a client-side `fs` implementation alone would not have
saved them either. M2e is therefore **not viable as a general design**; only
devin could use it, and a second workspace mode for one agent is not worth it.

**The companion clone stays.** Consequences that flip back to open (they were
dismissed while M2e looked like the target):

1. **Repo-reachability preflight — worth adding.** `checkEndpointReady`
   validates gateway/token/endpoint/agent but not repo access, so a companion
   that cannot clone a private repo passes preflight and fails at the first
   session, after model spend has started. Small probe (`git ls-remote` at
   `hello` or on open) with a real job now.
2. **Depth — closed by #118, not open.** Depth 50 plus deepen-to-merge-base gives
   the agent a working `git log` and `git diff base...head`, so the quality question
   this item raised no longer has a subject. The status table above is authoritative.

Why this was worth running: acting on the earlier decision would have deleted
`fetchWorkspace` and left three of four agents reviewing an empty directory —
**confidently**, with no crash and no error, just silently worse reviews. The
failure mode of an unverified protocol assumption is silence, not breakage.

M2a–c give the companion a checkout so the agent's own tools work. ACP
supports the inverse, which is the better end state for a hosted service:
advertise `fs.readTextFile` + `terminal` in `clientCapabilities` and serve
files and commands **from the client** (which already has the runner's
checkout and its GitHub token). The companion then needs no repo access at
all — it becomes purely agent access, and never touches customer code.

|                  | A — shipped              | B — client-served (M2e)                       |
| ---------------- | ------------------------ | --------------------------------------------- |
| Agent tools      | run on companion disk    | round-trip to the client                      |
| Companion needs  | repo + git creds         | nothing but the agent                         |
| Private repos    | needs companion git auth | works (runner holds the token)                |
| Uncommitted work | invisible                | works                                         |
| Cost             | none                     | implement client-side `fs` **and** `terminal` |

The expensive half is `terminal`, not file reads: bash is load-bearing for
review quality (AGENTS.md invariant 8 — git diff/log/grep), so B must
implement ACP's terminal capability (create/output/wait/kill) or reviews get
worse. An agent makes dozens–hundreds of tool calls per review, each becoming
a network hop, so measure latency before committing. Sequence B after the
launch gate; it is a milestone, not a tweak.

## M3 product direction — Slack bot as the first external client (2026-07-24)

Pivot: rather than build a desktop app and web client first, ship a **Slack
bot** that drives the user's own agent through the gateway. Slack supplies the
client, identity, mobile apps, notifications, and distribution — the work
reduces to Slack event handling on top of the existing relay. It is also the
opposite bet from buzz (which replaces Slack); this meets teams where they are.

**Product invariant: one workspace app, personal agent ownership.** An admin
installs the Slack app once, but that does not create one workspace-wide agent.
Each member explicitly pairs one or more companions running on machines they
control. The bot always uses the invoking member's identity, devices, agent
login, and filesystem; it never silently routes them to another member's
machine or credentials. A team may later register a Mac mini or cloud box as an
explicitly org-owned shared endpoint with its own ACL, but that is a separate
mode — not the M3 default and never a fallback for an offline personal endpoint.

- **Actor → endpoint binding.** Every Slack event carries its invoking user, so
  the bot resolves _that user's_ endpoint per message. Alice tagging runs
  Alice's agent, Bob tagging runs Bob's — in DMs or channels alike. No
  thread-level ownership and no arbitration. Consequence worth keeping: two
  people can put _different_ agents on the same thread context, each on their
  own subscription and machine — a primitive "the workspace has an agent"
  cannot express.
- **Two-post DM streaming model.** Slack allows roughly one write/second, so do
  not stream tokens there. In the private DM, post a link when work starts,
  stream reasoning/thinking to the gateway viewer (owner-scoped, behind
  login), then post the final draft — two writes plus one completion edit so
  there is no dead air. The source thread receives nothing beyond an optional
  reaction unless the member selects **Post when ready** or explicitly shares
  a reviewed draft.
- **DM-first, explicit share-back.** Agent iteration is messy and belongs in a
  DM; the invoker decides what reaches the channel. A mention in a public or
  private channel thread, or a Slack message shortcut, is a request to start
  new private work, not permission to publish the first answer. "Ask my agent
  about this" preloads the source-thread context into a new DM thread and asks
  privately whether to **Keep private** or **Post when ready**. The member can
  review the draft, ask follow-ups, request changes, or run more tasks before
  using **Share to thread**, or pre-authorize the quick answer to return
  directly to the originating thread.
- **Presence is already available.** `/api/endpoints` reports each endpoint's
  `online` flag, agents, and free capacity, so both the hosted site and the
  bot can show "your laptop is offline" instead of failing opaquely. Needs
  only the Slack-user → endpoint mapping to scope it per user.
- **Turn routing:** every tag in a public or private channel thread creates a
  new private DM conversation for the tagger and asks for its delivery mode. It
  never reuses a prior DM conversation. Untagged source-thread messages drive
  nothing.
- **Gates on M2d identity**, which now blocks four things: multi-tenant authz,
  owner-may-write permissions, web/Slack client auth, and owner-scoped
  reasoning links.

### Onboarding and account linking

The target flow is one Slack installation per workspace and one local command
per member — no Slack app construction or gateway configuration on individual
machines:

1. A workspace admin clicks **Add to Slack** once. OAuth creates the workspace
   tenant and installs the hosted bot.
2. A member DMs the bot and clicks **Connect my agent**. The bot opens a small
   control UI and issues a short-lived, single-use pairing code bound to that
   Slack workspace and member.
3. On the machine where their agents are already logged in, the member runs one
   command, illustrated as `jbot companion connect <code>`. It installs or
   starts the companion, which connects outbound; no public address is needed.
4. The companion detects available ACP agents and their local login state. The
   member chooses a default device and agent in the control UI.
5. The gateway records
   `(Slack team_id, Slack user_id) → owner identity → companion device keys`,
   plus the member's default endpoint/agent preference. Provider credentials
   remain local and are never copied into Slack or the gateway.
6. The DM shows the selected agent and live device presence, with controls to
   switch defaults, add another device, disconnect, or revoke a lost device.

Success means an ordinary member never creates a Slack app, copies bot/app
tokens, edits TOML, exposes a port, or uploads provider credentials. If no
personal endpoint is online, the bot says so and offers reconnection; it does
not run the request on a shared machine.

### Conversation model — one DM thread = one conversation

The private DM is not one endless chat. Each top-level DM thread is one durable
agent conversation, matching the Codex app's conversation model:

- Every mention in a public or private channel thread, or **Ask my agent about
  this**, creates a new DM root and a new `conversationId`. This remains true
  when the same member invokes the bot repeatedly from the same source thread;
  each invocation is a separate task. Starting a new top-level request in the
  DM does the same without source-thread context.
- The context snapshot includes every source-thread message available to the
  bot up to the invocation, with authors, timestamps, attachments, and links
  where its Slack scopes permit. The injected context still has a hard byte
  budget: if the thread exceeds it, preserve the root and most relevant/recent
  replies, then state exactly what was omitted. Later source-thread messages do
  not silently enter the task; another tag creates another DM conversation
  with a fresh snapshot.
- Every prompt, clarification, progress link, draft, failure, and follow-up for
  that conversation stays under that DM root. A reply in the thread always
  resumes that conversation; a new top-level DM starts a new one.
- The durable identity is
  `(Slack team_id, Slack user_id, DM channel_id, root thread_ts) →
conversationId`. The conversation then points to the selected personal
  endpoint, agent, and current ACP session. A transient ACP session id is never
  the user-facing conversation identity.
- Direct delivery or sharing a reviewed draft back to the source channel does
  not close or fork the private conversation. Later replies in the DM thread
  continue it and may produce a revised share-back.
- Public or private channel threads are context sources and share destinations,
  not agent session owners. Several members can independently create personal
  DM conversations from the same source thread without seeing or steering one
  another's private work.

On a thread reply, route to the live ACP session when it still exists; otherwise
reattach with `session/load`. For an agent that cannot reload, start a replacement
session with a budgeted recovery context from the durable transcript and mark
the turn as recovered rather than silently presenting an empty session as a
true resume. Exact process/tool state may be unavailable, but typing in an old
DM thread must always address the same conversation.

### Human approval and delivery mode

Invocation alone never authorizes publication. Immediately after creating the
private DM conversation, the bot presents two buttons while agent work starts
in parallel:

- **Keep private** — the default. Completion produces a private draft for
  review, follow-up, and optional **Share to thread**.
- **Post when ready** — a one-turn authorization to post the next successful
  final answer directly to the source thread. Thinking, tool output, permission
  prompts, and partial responses remain private.

If the member makes no choice, the task stays private. The member may change
the choice until publication. If the agent needs clarification, requests a
permission, or fails, direct delivery is cancelled and the conversation stays
private; after resolving it, the member can share the reviewed result or
authorize a later turn.

1. A mention in a public or private channel thread, or a message shortcut,
   snapshots the source thread and starts a new conversation in the invoker's
   DM.
2. The private delivery prompt lets the member approve direct delivery before
   completion without waiting to review a routine answer.
3. Without that approval, the agent may finish, fail, or ask a question without
   writing an answer into the source thread.
4. The member can continue a private draft for as many follow-up turns or tool
   runs as needed.
5. **Share to thread** previews the exact content and destination. The shared
   post identifies the member who approved it.
6. Posting does not end the private session; the member can keep working and
   share a later revision.

The bot must never interpret “the agent produced a final response” as “publish
this response” unless an unrevoked **Post when ready** authorization exists for
that turn. This preserves the review boundary for substantive work without
adding friction to quick questions.

```
  ── Slack's servers ──   ──────── our VPS (one box, behind Caddy TLS) ────────   ── Alice's own machine ──
  slack.com               bot.pgupai.com            observer.pgupai.com            no public address

  SLACK                        BOT (new)                  GATEWAY                COMPANION (Alice's laptop)
 ┌──────────────────┐   ┌────────────────────────┐   ┌───────────────┐   ┌──────────────────────────┐
 │ #incidents thread│   │ slack events → ACP     │   │ relay +       │   │ Alice's logged-in agent  │
 │  ⋯ stack trace   │   │ maps SLACK USER →      │   │ journal +     │   │ (codex / kilo / …)       │
 │                  │   │      that user's       │   │ viewer        │   │                          │
 │ [Ask my agent]───┼──▶│      endpoint          ├──▶│ open session  ├──▶│ spawn, run, stream       │
 │  (message        │ ① │ never a shared agent   │ ② │               │ ③ │                          │
 │   shortcut)      │   │                        │   │               │   │                          │
 │                  │   │                        │◀──┤ thinking ⋯    │◀──┤ agent_thought_chunk ⋯    │
 │ DM with bot      │◀──┤ ④ LINK + delivery      │   │  (SSE)        │   │                          │
 │ [Keep private]   │   │    choice              │   │               │   │                          │
 │ [Post when ready]│   │                        │   │               │   │                          │
 │  🔗 watch live   │   │                        │   │               │   │                          │
 │  … (quiet) …     │   │                        │   │               │   │                          │
 │  ✅ final draft  │◀──┤ ⑤ post RESULT          │◀──┴───────────────┴───┤ final message            │
 │  [Share] or      │   │                        │                       └──────────────────────────┘
 │  auto-post ──────┼──▶│ ⑥ authorized post      │
 └──────────────────┘   └────────────────────────┘
                                  │
   browser ◀── live reasoning ────┘  gateway viewer, owner-scoped (M2d)

  Hosting: the bot is a **new service that also needs a public HTTPS endpoint**
  (Slack POSTs events to it), so it co-locates on the VPS as a second Caddy
  site — same box, same deploy pattern as deploy/observer, separate process
  and token. It is a gateway *client*, not part of the relay: it holds no
  agent credentials and spawns nothing. Everything Alice's agent needs stays
  on Alice's machine, which never accepts an inbound connection.

  Bob does the same in the same thread → ② resolves to BOB's endpoint →
  Bob's own agent, his subscription, his machine. Two agents, one context.
```

Why each number matters: ① the shortcut is what carries **thread context** into
a private DM; ② the actor→endpoint map is the whole security model (no shared
agent, no arbitration); ④+⑤ are the two private progress/result writes, which
keeps it inside the ~1 write/second budget; ⑥ requires an explicit user grant,
either **Post when ready** before completion or **Share** after reviewing.

### Cloud tier — sell orchestration, not credential custody

"Migrate to cloud" (run the companion in our sandbox so the agent is always
on) is mechanically easy: the companion is the same binary, and the auth file
is copied in. Two hazards make the _business model_ the hard part, not the
engineering:

1. **Subscription ToS.** Running a user's personal Codex/Claude/kilo
   subscription on our infrastructure **as a paid service** is likely against
   those providers' terms — personal seats are for personal use. Verify per
   provider before pricing it.
2. **Custody inverts the trust story.** The local companion's whole claim is
   "your credentials never leave your machine." A tier where we hold
   `auth.json` takes on encryption-at-rest, key management, and breach
   exposure of the user's _provider account_, not just an API key.

Cleaner shape: charge for always-on hosting of **API-key providers** (custody
of an API key is normal and ToS-clean), for the gateway/Slack integration
itself per seat, or for managing a companion on the customer's **own** cloud
box. Subscription-credential agents stay local by default.

## Session tiers: machine-owned vs user-owned (M3 design decision)

Whether a session gets an ephemeral agent home is decided by **who owns the
session**, not by which agent serves it:

|                 | Machine-owned (jbot review)                           | User-owned (buzz, phone, editor)                      |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Initiated by    | a pipeline, unattended                                | the human, per turn                                   |
| Agent home      | per-spawn temp, discarded                             | the real one — shows in history                       |
| Resumable       | no (nothing persists)                                 | yes, via `session/load`                               |
| Read-only floor | enforced (untrusted PR content, no human in the loop) | should relax — the owner may legitimately want writes |

The second row is why review keeps temp homes: codex's `sandbox_mode`
read-only and its model selection both ride the temp `config.toml`, and kilo
needs its own data dir to avoid the SQLite race.

The last row is the non-obvious consequence. The companion's deny-floor exists
to stop a **remote party** from making the owner's agent write. When the
remote party _is_ the owner — authenticated as them — that rationale
disappears, and an unconditional floor would break the very thing they asked
for. So the floor must key on **identity**, not on remoteness: the same
ed25519 device keys that gate multi-tenant also decide "owner may write,
everyone else read-only." Signed envelopes are therefore a prerequisite for
the interactive tier, not just for audit.

## Token scoping defect (found 2026-07-24, single-operator only)

The gateway has **one** client token: the same value authorizes viewing a
run, ingesting observer frames, and **opening a session on any endpoint**.
Operationally that means a viewer URL shared for a demo also grants the
holder the ability to drive agents on the companion's machine — spending its
subscription and reading its workspace. The permission deny-floor still
blocks writes, and endpoint tokens are separate (a companion cannot be
impersonated), but read/drive are not separable today.

Fix belongs with the launch gate's per-owner authz: split viewer (read,
short-lived), client (drive), and endpoint (serve) into distinct scopes.
Until then, treat the gateway token as an agent-driving credential — never
share a `?token=` viewer URL — and stop the companion when not in use, since
an offline endpoint is unreachable by construction.

## Rollout (phase definitions — current state is the status table above)

1. **M2a — relay + companion:** gateway routes, companion binary, laptop demo
   (kilo via companion, watched live in the viewer; transcript identical to
   today's tee output).
2. **M2b — review through it:** `npm run review:local` with
   `JBOT_ACP_GATEWAY_*` set drives a full review on a remote endpoint;
   dogfood on a real PR branch.
3. **M2c — CI thin client:** dogfood workflow variant with zero provider
   keys; presence check + loud failure; README + deploy docs.

Each phase lands as its own PR with the standing self-review/de-slop loop.

## Testing

- Pure: envelope/control parsing, router pairing/teardown, presence — unit
  tests beside `gateway.test.ts`'s existing style.
- Black-box: spawn gateway + a **fake companion** wrapping a scripted echo
  agent (the `demo.ts` frame corpus is the fixture source) + a real
  `createRemoteAcpBackend` client; assert transcript equality with the local
  spawn path and journal/viewer parity (pattern: `observer.test.ts`).
- Failure drills: kill companion mid-session (client gets loud error, run
  marked failed), kill gateway (companion reconnects, fresh session works),
  buffer overflow (session fails, process survives).

## Security & isolation model

Governing requirement: **a party who is not the owner of a session or endpoint
must not be able to read, join, drive, or even enumerate anything belonging to
the owner or another user — on the wire, in the journal, or on any companion
host.** Every boundary is enforced independently (defense in depth); no single
check is load-bearing alone.

### Assets and adversaries

Assets: (A1) live session frames — source + prompt content; (A2) agent
credentials — companion-only, never on the wire; (A3) files/secrets on a
companion host — SSH keys, other repos, browser state; (A4) persisted
journals; (A5) control over what a companion runs.

Adversaries: (T1) unauthenticated internet; (T2) an authenticated but
malicious client reaching for another user's endpoint/session; (T3) a
malicious companion trying to receive others' sessions or squat an endpoint
id; (T4) untrusted PR content executing inside a review session on a companion
host; (T5) a co-tenant on the shared gateway; (T6) full gateway compromise.

### Identity, not possession (T2/T3/T5)

- Three token scopes (client, endpoint, viewer), constant-time compared
  (`tokenMatches`). At M3 the trust root becomes the ed25519 identity keys
  (signed-envelopes §): every connection binds to a verified pubkey, and
  **endpoint ids are namespaced under the owning identity** — two users'
  `laptop` endpoints are distinct objects that can never collide or cross.
  Ids are never global, which closes TOFU squatting.
- Session ids are unguessable (128-bit random) **and** every frame is checked
  against an ownership table `sessionId → {clientKey, endpointKey}`: the
  sender must be one of the two bound parties. A leaked or guessed sid buys
  nothing — possession is never authorization.

### Two-sided authorization for every session (T2/T3)

- Gateway ACL, enforced on `open`: a client may open only on an endpoint its
  identity is authorized for; a companion is advertised only to authorized
  clients.
- The companion **re-checks independently**: an allowlist of client identities
  permitted to open sessions on it. A buggy or bypassed gateway ACL still
  cannot make a companion accept an unknown driver. Two gates, either
  sufficient to deny.

### Companion host isolation — the inversion (T4, the hard one)

The read-only deny-floor (`respondToPermissionRequest`, applied
**companion-side and independent of the client's answer**) stops ACP _tool_
writes — but **bash stays enabled for git/grep, and bash can read `~/.ssh` or
exfiltrate over the network regardless of ACP permission mode.** Permission
mode is necessary, not sufficient. The host floor:

- Each session runs in an OS sandbox: unprivileged throwaway user + fresh
  mount namespace, home dir absent, only the throwaway workspace visible; the
  agent credential is injected into the agent process's config path but is
  **not readable from the workspace/bash context**.
- Egress allowlist: the agent reaches its provider API and nothing else
  (blocks curl-out exfiltration). This is the genuinely hard part — stated as
  hard, not waved away.
- Repo fetch is confined to the authorized repo@ref — never an arbitrary
  URL/repo (no confused-deputy abuse of the companion's git creds). The ref is
  attacker-influenced, so all git invocation is argv, never shell-interpolated.
- This floor is a **hard launch gate** (below), not an MVP nicety.

### Credential & gateway-compromise confinement (A2, T6)

- Agent credentials never cross the wire and never touch the gateway — gateway
  compromise cannot leak them.
- Signed envelopes make the journal tamper-evident and attribution
  unforgeable even against a compromised gateway.
- Blast radius of gateway compromise = frames in transit + journal (sensitive
  source/prompts, **no credentials**). For sensitive tenants, an optional
  **end-to-end mode**: client↔companion encrypt frames, gateway relays
  ciphertext (blind relay). Cost: no server-side journal/live-viewer for E2E
  sessions. Per-session choice — _observable_ (journaled, watchable) vs
  _blind_ (E2E, private). Review sessions default observable.

### Journal & viewer authorization (A4, T5)

Every read route (`/api/runs`, session stream, endpoints listing) is scoped to
the requesting identity — a user lists and replays only their own runs.
Authentication ≠ authorization; M1's "one token = everything" is replaced
before any second tenant. Viewer access becomes **short-lived, per-owner
tokens** (retires the M1 long-lived `?token=` query credential, which CodeRabbit
flagged on #106 and we deferred).

### Resource isolation (DoS)

Per-endpoint `maxSessions` (companion) + per-identity session/rate quotas
(gateway); bounded frame buffers already cap memory, and overflow fails the
one session, never the process or a co-tenant.

### Launch gate (hard)

Single-operator M2 — your endpoints, your tokens — is safe with two-sided auth

- companion deny-floor + workspace hygiene + argv-only fetch. **The gateway
  MUST NOT accept a second tenant until all of these ship and are tested:**
  namespaced identity keys, per-owner journal/viewer authz, and the host sandbox
  floor. Multi-tenant and hardened isolation ship together or not at all — a
  gate, not a backlog item.

### Read-only enforcement residual (launch-gated)

A relayed session's `initialize`/`session/new`/mode frames come from the
client, so the companion does not itself re-apply the plan-mode + empty-
mcpServers + capability clamping that `driveAcpSession` sets for
`requirePlanMode` agents. What M2a enforces companion-side regardless of the
client: codex read-only pinned in the spec env, and the permission deny-floor
(write/edit/patch/delete/move/switch_mode) on every agent. The gap — an
**untrusted** client omitting the initial read-only setup for
kilo/cursor/devin — is a multi-tenant threat: M2a/M2b's client is jbot's own
read-only driver, and comprehensive companion-side mode/capability clamping
ships with the multi-tenant launch gate alongside the workspace sandbox.

### Retained flag

Check subscription ToS (Anthropic/OpenAI/…) before marketing "subscription in
CI" as the headline — for a hosted _service_ this is platform risk, not just
personal risk.

## Resolved questions (operator, 2026-07-24)

1. Flat endpoint ids for MVP, **plus a `device` indicator** in the hello
   control (see Wire protocol) shown in presence and the viewer.
2. Journals use the **client's run id** (`pr-…` / `local-…`), same naming as
   today.
3. Cross-owner private-repo fetch: out of scope for MVP (companion uses its
   own auth); revisit with multi-tenant M3.
4. VPS sizing: operator upgrades the box when M2 lands; no design constraint.

## Committed convergence triggers (adopt when hit, not before)

| Trigger                                                           | Adoption                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First web/mobile client (browser can't stream the NDJSON up-half) | add wss alongside the HTTP pair, same envelopes                                                                                                                                                                                                                                                              |
| Second real tenant, or search/retention needs                     | Postgres (journal behind `appendEnvelope`/`readJournalLines`) + Redis pub/sub (fan-out module) + multi-process gateway. Note what this buys: rolling zero-downtime deploys, horizontal fan-out, search, retention — **not** session churn-survival, which resume semantics (Delivery §) provide at any scale |
| Multi-tenant identity / device grouping                           | envelope signing (below) replaces static endpoint tokens as the trust root                                                                                                                                                                                                                                   |

## Signed envelopes (committed — borrow buzz's strongest idea, keep the pipe dumb)

Buzz signs _translated events_; we sign **the envelope, not the frame**, so
attribution and tamper-evidence arrive without touching protocol fidelity:

- Companion and client each generate an ed25519 keypair on first run
  (`node:crypto`, zero deps) and include the pubkey in `hello`; the gateway
  records it on first sight (TOFU) next to the endpoint token. Tokens remain
  the transport auth; signatures add _attribution_.
- Signed payload **as shipped**: the serialized envelope minus its own `sig`,
  which is appended last so a verifier reconstructs the signed bytes exactly
  after the relay's JSON round trip. This replaces the planned
  `{runId, sessionId, seq, ts, sha256(frame)}` digest — that shape needs a
  canonical JSON agreement (key order, number formatting, escaping) between
  every producer and reader, and signing the emitted bytes sidesteps it.
  Signature travels in the envelope, is journaled verbatim, and verifies
  offline (`scripts/verify-journal.ts`) — the journal becomes tamper-evident
  per actor without the gateway being trusted for attribution.
- Keys are **per companion**, generated on first run at
  `~/.local/share/jbot-companion/signing-key.pem` (0600) and advertised via
  `hello.publicKey`; the gateway holds only public halves, one per endpoint.
  The public half is also written beside it (`signing-key.pub.pem`) as the
  gateway-independent channel: an audit that distrusts the gateway needs a key
  that never came from it. Deliberate ceiling — a fully compromised gateway is
  shut down and rotated, not defended against in-band; runtime components do
  not pretend to operate across a compromised peer. Signatures are evidence
  for the post-incident question of which stored runs still deserve belief.
  Anything not provably intact — tampered, unsigned, or unparseable — counts
  the same, so stripping a signature is not a cheaper attack than forging one.
- Slotted as **M2d**: additive, independently landable after M2c; becomes
  load-bearing at M3 when device keys group under a user identity.

## Durable history and multi-device (design position)

- **Durable transcript history — largely already true.** Journals persist
  and replay today; what M3 adds is librarianship (retention, listing,
  search), which is exactly the Postgres trigger above. No design change.
- **Durable conversations and resumable sessions are distinct.** The Slack DM
  root maps to a stable conversation record and a lineage of replaceable ACP
  sessions. Live session state still resides in the agent process, and ACP's
  `session/load` capability is the sanctioned exact-resume path. The companion
  persists agent session storage and re-attaches where the agent supports it
  (a per-agent capability in the quirk matrix). The gateway keeps conversation
  metadata, the current session binding, and resumability status. Where exact
  reload is unavailable, a replacement session receives a budgeted recovery
  context from the journal and is visibly marked recovered. Review sessions
  stay ephemeral by design.
- **Multi-device, agent side — already in M2**: N companions per user, flat
  ids + `device` tag, presence-based pick. Identity _grouping_ of devices
  arrives with signing (one user identity → many device keys) — the same
  feature doing double duty.
- **Multi-device, client side — watching is already free** (SSE fan-out +
  seq replay lets a phone join late and catch up). Interactive sessions are
  single-driver by ACP nature, so multi-device _interaction_ = one driver +
  N observers with a `{kind:'handoff'}` control to move the driver seat.
  Small protocol addition, journal replay keeps every device consistent.

## Stack scorecard vs buzz (reference snapshot, 2026-07-24)

Three columns on our side keep it honest: _today_ is running, _committed_ is
spec'd with a named trigger or milestone — and unbuilt, while buzz's column
runs in production.

| Axis                 | Ours — today                                               | Ours — committed                                                                                       | Buzz                                                                                                            |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Ops burden           | ~zero: one 28 KB binary, rsync deploy, no services         | grows only when triggers fire                                                                          | three backing services before the first user                                                                    |
| Velocity             | shared types/tests/language with the first client, in-repo | unchanged                                                                                              | separate stack from any client                                                                                  |
| Browser clients      | upload half not browser-safe                               | wss at first web/mobile client, same envelopes                                                         | WS is browser-universal — right here                                                                            |
| Restart/churn        | viewers resume; sessions fail loud                         | resume semantics in M2 wire v1 (seq cursors, journal-as-ack-log, SIGTERM drain; loud only past window) | event log replay = same catch-up; their real edge is rolling multi-process deploys (our Postgres/Redis trigger) |
| Scale                | deliberately scale=1                                       | multi-process gateway at 2nd-tenant trigger                                                            | horizontal day one                                                                                              |
| Search/retention     | grep the NDJSON                                            | full-text + retention with the Postgres trigger                                                        | built in                                                                                                        |
| Identity & audit     | bearer tokens, unsigned journal                            | ed25519 signed envelopes (M2d, shipped) — per-companion key, tamper-evident, pipe stays dumb           | Schnorr-signed events day one — the borrowed idea                                                               |
| Journal/viewer authz | single shared token (M1 debt: long-lived `?token=`)        | per-owner scoping + short-lived viewer tokens — launch-gated                                           | identity-scoped via keys/membership                                                                             |
| E2E confidentiality  | gateway sees frames (journal/viewer need them)             | optional per-session blind-relay mode                                                                  | relay stores/indexes plaintext events — we exceed here                                                          |
| Multi-tenancy        | single operator only                                       | only after the launch gate (keys + authz + host sandbox)                                               | multi-tenant day one                                                                                            |

## End state (M3+) and buzz alignment

The M2 shape is deliberately the seed of the bigger goal — a hosted ACP
gateway where **any client** (desktop, mobile, web, CI runner) reaches **any
ACP agent** (cloud or local):

- **Any client, without gateway changes:** dumb-pipe means client diversity
  is an _edge adapter_ problem, and every prospective client is the same
  shape — something that opens a session on an endpoint and speaks ACP frames.
  Two adapter forms cover them all:
  - **stdio shim** for clients that already spawn ACP agents as subprocesses
    (editors like Zed, and buzz's `buzz-acp` — see below): a tiny binary that
    presents as a normal ACP agent over stdio while dialing the gateway. The
    mirror image of the companion. Existing clients work unchanged — they
    think they spawned a local agent.
  - **native client** for surfaces that talk to us directly (a Slack bot, a
    web/iOS chat UI): translate the surface's messages ↔ ACP prompts/updates
    over the gateway's client routes. The observer **viewer is already a
    read-only instance** of this — it renders streamed thinking/response
    frames; add a prompt input + a prompt-POST and it becomes a chat client
    driving the user's logged-in agent from a browser or phone.
- **Web/mobile transport:** the SSE down-half is browser-native. A _chat_
  client sends discrete prompts, so a POST-per-message up-channel is also
  browser-native — no wss needed. wss is the trigger only for _continuous_
  bidirectional streaming (companion-style), per Transport.
- **Any agent:** `AcpAgentSpec` is already generic ({command, args, env} +
  quirk hooks); "all providers" is user-supplied spec entries plus the M0
  quirk tolerance (drain, timeouts, loud errors), not new architecture.
- **buzz (verified against block/buzz, Apache-2.0):** same _topology_
  (central relay, agent harness, clients, presence, one event log) —
  convergent because it is the only sane shape for NAT'd agents — but a
  different _protocol layer_: buzz's `buzz-acp` harness translates ACP into
  signed Nostr event kinds for a chat product (agents as members with
  Schnorr keys); we relay raw ACP frames with a thin envelope. Borrow from
  buzz: per-agent bridging quirks in `buzz-acp` (Goose/Codex/Claude Code),
  presence patterns (Redis pub/sub) when we outgrow one process, and the
  per-identity-key idea as M3's upgrade path from static endpoint tokens.
  Skip: Nostr coupling and the event-translation layer (their product moat,
  our explicit anti-goal). **Integration mechanism (concrete):** `buzz-acp`
  is an ACP _client_ — it spawns a binary and drives it. Point it at our
  stdio shim as the "agent command" and buzz reaches an agent on _our_
  gateway (remote, behind NAT, broader provider set) thinking it spawned a
  local Goose/Codex — **zero buzz code change**, credentials never leaving
  the user's machine. This composes _only because we stay protocol-faithful_:
  had we translated ACP into our own event model, buzz couldn't plug in
  without adapting to our events. Fidelity is what makes buzz an integration
  target (our client for reach; we, their remote-agent backend) rather than a
  rival — each keeps its own layer.
