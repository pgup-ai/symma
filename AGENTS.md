# symma — agent guide

Platform for connecting a chat surface to a coding agent running on the user's
own machine, with their own credentials. Being extracted from
[pgup-ai/jbot-review](https://github.com/pgup-ai/jbot-review), which stays put
as its first downstream client. This file is the single source of truth for
agents working in this repo; `CLAUDE.md` just points here.

Repo skills live under `.agents/skills`: use `symma-de-slop` for a hostile
cleanup pass before pushing, opening, or updating a PR.

Full design: `docs/design/m3-slack-companion.md`, kept out of this repo and local
to the maintainer's machine. Section references below (§N) are to it, so they
resolve only in a checkout that has it — everything an agent must actually obey
is here, and no rule below depends on reading it.

## Commands

- `npm test` — all tests (node:test via tsx). **Needs Docker running**: the
  gateway's tenancy test starts a throwaway Postgres via testcontainers, because
  owner scoping is only worth asserting against a real database. Single file:
  `node --conditions=symma-source --import tsx --test packages/<pkg>/test/<file>.test.ts`
  (the condition is what resolves `@symma/*` to source)
- `npm run typecheck` / `npm run lint` / `npm run format` / `npm run format:check`
  — tsc, oxlint (deny-warnings), prettier (owns formatting)
- `npm run build` — `tsc` emits into `dist/` for the three packages that
  publish: `@symma/protocol` and `@symma/client` (JS + `.d.ts`, they are
  libraries) and `symma` (JS only, it is a CLI with a `bin` and no exports).
  `gateway` stays private: it runs from source under tsx and builds nothing.
- `npm run verify:pack` — packs all three published packages and loads them the
  way a consumer does. The suite runs under `--conditions=symma-source` and
  `tsc` resolves `@symma/*` to source, so the `dist` entry, the published types
  and the tarball's contents are exercised only here. `symma` exports nothing to
  import, so what it checks there is that the installed binary starts. Run it for
  any change to `exports`, `files`, `bin` or the emitted types. It does not check
  a barrel is complete — it imports a handful of symbols, so a missing export
  still passes.
- Sources import each other as `./foo.js` — NodeNext convention: write the
  extension the output will have, and `tsc` and tsx both resolve the `.ts`.
  Writing `.ts` breaks the emit.
- The two published libraries resolve to `src` in the workspace through the
  `symma-source` export condition, and to `dist` everywhere else. `symma` has no
  exports, so nothing resolves into it — it is only ever run. Any process
  that runs from source needs `--conditions=symma-source`, including ones a test
  spawns — a child does not inherit the flag. `@symma/gateway` is private and
  maps straight to source with no condition.

## Packages

§8 "Package graph". All five exist; `@symma/slack` arrived with M3d and carries
`/connect`, mentions, DM turns, §3's presence copy, and driving one prompt on
the member's own machine — in one of §4's allowlisted directories when their
companion offers any, and an empty temp one when it offers none. The choice is
per conversation and named in the DM root. A follow-up reattaches to the agent
session the last turn ran in when that machine, agent and directory are still
the ones it was minted under (§4's second rung), and is caught up from the DM
thread when they are not. Both travel every turn: whether the agent still holds
the session is not known until it has been asked, so the transcript goes with
the resume and the driver drops whichever does not apply. A conversation runs
one turn at a time — two at once fork the session that carries it, and neither
half then holds the whole thread — so a second message waits and is told so.
Slack permalinks pasted into a message are fetched by the bot and ride the
prompt — not the context, which an honoured resume drops — because the agent has
only its own machine's Slack access, which is usually none. The bot reads with
its own token and is in whatever it was invited to, so it fetches only what the
member could have opened themselves: a public channel, their own DM with it, or
a private channel or group DM they are in. Every other link is named to them
with its reason and left to an agent that can reach it. An answer leaves the DM only when the member
presses the button (§5): the gateway states where it may go, the shared post
names who approved it, and a destination gone bad keeps the answer here. The
mode and model pickers ride the answers, so both are chosen mid-thread; the
model is also choosable before there is a thread, through `/model` and the home
tab, because a roster is learned by running and a member who has to ask first to
pick has already asked on the wrong model. The gateway keeps the roster from the
last turn and the member's own default under it. The agent is chosen the same
way, on the home tab and only where the machine offers more than one — a pick
their companion stops advertising falls back rather than refusing the turn, and
nothing has to be shed with it because a model is served only to the agent it
was picked under and a resume only to the one it was minted under. An answer
shared back goes out as the member themselves once they have linked their Slack
account (§5): Slack decides authorship by token type, so the gateway holds one
`chat:write` user token per member and hands it to the bot for that one post,
which they can hand back from the same tab. Without the link it is the bot
posting with their name in front, as before.

| package           | what it is                                                                                                                                                                         | depends on                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `@symma/protocol` | ACP framing, JSON-RPC peer, `driveAcpSession`, agent specs + credential helpers, read-only permission floor, envelope signing, observer envelope, relay control + presence, ndjson | —                           |
| `@symma/gateway`  | relay, journal store, viewer, HTTP API, tenancy                                                                                                                                    | protocol                    |
| `symma`           | the companion CLI — attach loop, agent detection, workspace allowlist, checkout mechanism, local spawn/lifecycle, pairing, login service                                           | protocol                    |
| `@symma/client`   | drive an ACP prompt: local spawn/lifecycle, gateway transport                                                                                                                      | protocol                    |
| `@symma/slack`    | the bot — Socket Mode, `/connect`, `/model`, home tab, mentions, DM turns, presence copy; no agent credentials, spawns nothing                                                     | client, protocol, Slack SDK |

`@symma/client` is what jbot-review consumes at runtime, and now what the bot
does too. It exists so neither imports gateway internals to dial a gateway — the
inversion this extraction fixes, prevented from recurring. The bot holding no
credential of its own is why it is handed a short-lived, member-scoped one per
turn rather than a standing key.

## Invariants — do not break these

1. **Read-only enforced in three layers.** On the ACP path: the client-side
   permission floor (`respondToPermissionRequest` — mutating tool kinds
   rejected, `*_once` preferred so no grant outlives a single call), the
   agent-side sandbox (codex's OS sandbox), and plan mode (the behavioural
   read-only layer for agents with no sandbox; `requirePlanMode` fails closed).
   Bash stays allowed for git diff/log/grep — command-level policing belongs to
   the agent-side layers, not the floor, which is deliberately kind-based and
   allow-by-default for unknown kinds.

   **Scoped to the review path and to read-only DM turns.** M3's DM path
   inverts the caller — the endpoint's owner, on their own machine — and §4's
   "read-only ends where the caller changes" is now a mechanism, not prose: a
   DM conversation pinned to an allowlisted workspace runs a session mode the
   member picked (codex's own `read-only`/`agent`/`agent-full-access`), and a
   write-capable mode swaps the companion floor to a `writes` policy. What
   stays unconditional: writes are never allowed outside a named workspace
   (the companion refuses the open), a mode reaches a companion only through
   the owner's explicit choice (the gateway serves one solely for endpoints
   whose hello advertised `modes` for the agent, so an old companion stays a
   read-only one), and no session can escalate itself — `switch_mode` is
   denied under every policy, and the read-only policy additionally denies
   MCP tool approvals (codex-acp 1.1.7 marks them `_meta.is_mcp_tool_approval`
   with kind `execute`, a kind the floor otherwise allows for git; MCP servers
   run outside the OS sandbox, so the floor is the only layer that sees them).
   Named-workspace codex sessions run from the member's real `~/.codex` —
   their config, MCP servers and session history — so "read-only" there means
   codex's read-only mode plus this floor, not an empty environment.

2. **Auxiliary sessions fail open.** A broken precision filter must never
   become a recall hole.

3. **Compromise means shutdown, not mitigation.** Components never try to keep
   operating across a compromised peer — it is shut down and its tokens
   rotated. In-band attestation points only downward in the trust chain: a
   viewer served by the gateway can never audit the gateway.

4. **Mechanism moves, policy stays.** symma owns the capability, the caller
   owns the decision. The companion learns _how_ to clone a ref into a temp
   dir; it never learns _which_ ref or why. Review-specific repo/ref choice,
   the three-dot rule and the throwaway-checkout policy stay in jbot-review.

5. **`@symma/protocol` imports nothing review- or gateway-specific.** That
   boundary is why the package extracts at all; an import crossing it is the
   bug, not the boundary. Timeouts and retry policy are caller concerns —
   the protocol surfaces transport facts and lets the caller set deadlines.

6. **Fixes to extracted code land here** (§8). jbot-review holds no copies of
   `@symma/protocol` or `@symma/client` any more, so a fix reaches it as a
   release _and_ a pin bump there — the pins are exact, and publishing alone
   moves nothing. Patching its copy re-forks the code that was just unforked.

   **`gateway` is outside this.** It publishes nothing, so jbot-review still
   runs its own and the two have already drifted: symma's `server.ts` has a
   cross-run guard, a fail-open journal write and a `q=0`-aware `acceptsGzip`
   that jbot-review's does not. Whoever ships it reconciles the drift and
   extends this entry to cover it. The companion left this exemption when it
   became `symma` on npm, so a fix to it now travels as a release like the
   libraries do.

## Conventions

- TypeScript ESM. Import specifiers end in `.js` and resolve to `.ts` — writing
  `.ts` breaks the emit. No new dependencies without clear need: `@symma/slack`
  takes `@slack/web-api` and `@slack/socket-mode`, and the bar they cleared was
  defects the review had already found, not anticipation.
- Agent specs are verified twice, in this order: the
  [ACP registry](https://github.com/agentclientprotocol/registry) first for the
  canonical package, bin and launch flags — `npx` runs deprecated packages
  without a word, and the registry is what caught claude-code-acp's rename —
  then a live probe of the real CLI before the spec is written (§3's bar).
- Agent capabilities are read off `initialize`, never assumed. `loadSession`
  was documented as absent for months on nobody's evidence, and one probe of
  the binary already in use disproved it. A capability claim in a comment cites
  the version it was checked against or it is a guess.
- `PROTOCOL_VERSION` is the wire generation; a gateway serves it and the one
  below (§7.1), and `hello` without one is generation 0. A bump refuses every
  companion two back — laptops we do not control — so teach both sides to
  tolerate a change before the release that requires it, never in the same one.
- Tests: node:test + `node:assert/strict`; pin invariants, not incidental prose.
- Prettier owns formatting. Never hand-format, and never reformat a file you did
  not otherwise change — copied files must stay byte-identical to their origin
  until the originals are deleted, so a stray formatter run is a real
  regression, not cosmetic noise. Pin the prettier version when a copy has to
  match jbot-review exactly.

## Code hygiene

Ship the smallest change that does the job. If a reviewer can delete a line
without losing behavior, it should not have been written.

- **Comments earn their place** by explaining the non-obvious WHY. Delete any
  comment that restates the code; one line beats three. Don't narrate the
  size/layer of a change.
- **No dead surface.** No field, parameter, option, generic, or exported helper
  without a caller. Inline a helper used once; don't add speculative generality
  or "flexibility" nobody asked for.
- **No defensive cruft.** No null checks for values a caller already guards, no
  `catch` that only rethrows, no fallbacks for states that cannot occur.
  Validate once at the trust boundary and let real bugs throw. (The required
  auxiliary-session fail-open — see the Invariants — is the one exception.)
- **Reuse before adding.** Search for an existing helper before writing one;
  extend it rather than fork a parallel copy.
- **Match the surrounding code** — its density, naming, and idiom. No ceremony,
  no names spelled longer than their neighbours.

## Extraction status

§8 sequence, current position marked:

1. Create `pgup-ai/symma` — README, workspaces, design doc. **done**
2. Copy the self-contained components in, with their tests. **done** — protocol,
   gateway, companion
3. Split `acp.ts` / `acp-remote.ts` **here, not there** — symma takes only the
   generic halves; `ReviewBackend` wrappers and routing policy never leave
   jbot-review. **done** — `observer.ts` stays behind: every caller of it is
   review-side, so it is not symma's to hold.
4. Publish `@symma/*`, exact-pinned. **done** — `@symma/protocol`,
   `@symma/client` and the companion as unscoped `symma` are on npm; only
   `gateway` stays private.
   Intra-workspace pins must equal the workspace version exactly (the
   package.json files are the record; `*` resolves to the registry copy instead
   of the local one), so bumping a package means bumping every pin on it in the
   same commit.
5. Only now touch jbot-review: swap imports, keeping the local files in place.
   **done** — jbot-review#125 and #126.
6. Cross-repo green → delete the originals. **done** — jbot-review#127.
