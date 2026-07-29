# symma — agent guide

Platform for connecting a chat surface to a coding agent running on the user's
own machine, with their own credentials. Being extracted from
[pgup-ai/jbot-review](https://github.com/pgup-ai/jbot-review), which stays put
as its first downstream client. This file is the single source of truth for
agents working in this repo; `CLAUDE.md` just points here.

Full design: [`docs/design/m3-slack-companion.md`](docs/design/m3-slack-companion.md).
Section references below (§N) are to that document.

## Commands

- `npm test` — all tests (node:test via tsx). **Needs Docker running**: the
  gateway's tenancy test starts a throwaway Postgres via testcontainers, because
  owner scoping is only worth asserting against a real database. Set
  `SYMMA_TEST_DATABASE_URL` to use one that already exists and skip the
  container — which is what CI does, since pulling the image there cost minutes
  per run. Single file:
  `node --conditions=symma-source --import tsx --test packages/<pkg>/test/<file>.test.ts`
  (the condition is what resolves `@symma/*` to source)
- `npm run typecheck` / `npm run lint` / `npm run format` / `npm run format:check`
  — tsc, oxlint (deny-warnings), prettier (owns formatting)
- `npm run build` — `tsc` emits JS + `.d.ts` into `dist/` for the two packages
  that publish, `@symma/protocol` and `@symma/client`. `gateway` and `companion`
  are private applications: they run from source under tsx and build nothing.
- `npm run verify:pack` — packs both packages and loads them as a consumer
  would: resolution, the tarball's contents and the types, none of which
  anything else covers. It does not check the barrel is complete — it imports a
  handful of symbols, so a missing export still passes. Run it for any change to
  `exports`, `files` or the emitted types. the suite runs under `--conditions=symma-source` and
  `tsc` resolves `@symma/*` to source, so the `dist` entry, the published types
  and the tarball's contents are exercised only here.
- Sources import each other as `./foo.js` — NodeNext convention: write the
  extension the output will have, and `tsc` and tsx both resolve the `.ts`.
  Writing `.ts` breaks the emit.
- The two published packages resolve to `src` in the workspace through the
  `symma-source` export condition, and to `dist` everywhere else. Any process
  that runs from source needs `--conditions=symma-source`, including ones a test
  spawns — a child does not inherit the flag. `@symma/gateway` is private and
  maps straight to source with no condition.

## Packages

§8 "Package graph". `@symma/protocol`, `@symma/gateway`, `@symma/companion` and
`@symma/client` exist today; `slack` arrives with M3.

| package                    | what it is                                                                                                                                                                         | depends on       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@symma/protocol`          | ACP framing, JSON-RPC peer, `driveAcpSession`, agent specs + credential helpers, read-only permission floor, envelope signing, observer envelope, relay control + presence, ndjson | —                |
| `@symma/gateway`           | relay, journal store, viewer, HTTP API, tenancy                                                                                                                                    | protocol         |
| `@symma/companion`         | attach loop, agent detection, checkout mechanism, local spawn/lifecycle, self-update, pairing                                                                                      | protocol         |
| `@symma/client`            | drive an ACP prompt: local spawn/lifecycle, gateway transport                                                                                                                      | protocol         |
| `@symma/slack` _(planned)_ | the bot — dials the gateway like any other client                                                                                                                                  | client, protocol |

`@symma/client` is what jbot-review consumes at runtime. It exists so the
reviewer never imports gateway internals to dial a gateway — the inversion this
extraction fixes, prevented from recurring.

## Invariants — do not break these

1. **Read-only enforced in three layers.** On the ACP path: the client-side
   permission floor (`respondToPermissionRequest` — mutating tool kinds
   rejected, `*_once` preferred so no grant outlives a single call), the
   agent-side sandbox (codex's OS sandbox), and plan mode (the behavioural
   read-only layer for agents with no sandbox; `requirePlanMode` fails closed).
   Bash stays allowed for git diff/log/grep — command-level policing belongs to
   the agent-side layers, not the floor, which is deliberately kind-based and
   allow-by-default for unknown kinds.

   **Scoped to the review path.** M3's DM path inverts the caller — the
   endpoint's owner, on their own machine — and allows writes inside an
   allowlisted workspace root (§4, "Read-only ends where the caller changes").
   That path does not exist in code yet, so this invariant is unconditional
   today; whoever builds it amends this entry in the same commit.

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

   **`gateway` and `companion` are outside this.** They publish nothing, so
   jbot-review still runs its own, and the two have already drifted: symma's
   `server.ts` has a cross-run guard, a fail-open journal write and a
   `q=0`-aware `acceptsGzip` that jbot-review's does not. Whoever ships those
   packages reconciles the drift and extends this entry to cover them.

## Conventions

- TypeScript ESM. Import specifiers end in `.js` and resolve to `.ts` — writing
  `.ts` breaks the emit. No new dependencies without clear need.
- Agent specs are verified twice, in this order: the
  [ACP registry](https://github.com/agentclientprotocol/registry) first for the
  canonical package, bin and launch flags — `npx` runs deprecated packages
  without a word, and the registry is what caught claude-code-acp's rename —
  then a live probe of the real CLI before the spec is written (§3's bar).
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
4. Publish `@symma/*`, exact-pinned. **done** — `@symma/protocol` and
   `@symma/client` are on npm; `gateway` and `companion` stay private.
   Intra-workspace pins must equal the workspace version exactly (the
   package.json files are the record; `*` resolves to the registry copy instead
   of the local one), so bumping a package means bumping every pin on it in the
   same commit.
5. Only now touch jbot-review: swap imports, keeping the local files in place.
   **done** — jbot-review#125 and #126.
6. Cross-repo green → delete the originals. **done** — jbot-review#127.
