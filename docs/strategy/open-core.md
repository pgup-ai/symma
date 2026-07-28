# Open core and pricing — where the line goes and why

- **Date:** 2026-07-27
- **Status:** thinking, not decided. Nothing here is committed to.
- **Related:** [`design/m3-slack-companion.md`](../design/m3-slack-companion.md)
  §1 (tenancy), §2 (pairing), §3 (companion), "Data lifecycle"

Two questions that turn out to be one: what do we charge for, and what do we
publish. Both answers fall out of a single fact about the architecture.

## The fact that decides both

**The gateway is in the data path for every byte.** Every ACP frame — prompt,
agent reasoning, tool calls, output — is relayed through it and journaled. M2's
own numbers: one review is ~6800 frames, the largest journal ~9MB.

This is the difference that matters when copying anyone else's playbook.
Tailscale's coordination server is _not_ in the data path — WireGuard runs
peer-to-peer, and the DERP relays are a fallback for hostile NATs rather than the
normal case. A free Tailscale user costs them coordination metadata, which is why
"unlimited devices, free" is affordable for them and would not be for us.

We cannot copy the trick either. Going peer-to-peer after rendezvous would delete
the journal and the viewer, and those are product rather than overhead — the
journal is what makes a relayed session auditable, and §1 makes it the thing
tenancy is enforced over.

**So our marginal cost scales with usage, not seats.** ngrok and Slack are the
closer cost comparables. Tailscale is the right model for the _open/closed line_
and the wrong one for the price list.

## Pricing shape

Charge for what costs us, which is relayed bytes and retained journals — not for
the number of people.

| lever                 | why it fits                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| **sessions / month**  | tracks relay cost directly, and it is the unit a member already understands ("a task")             |
| **journal retention** | §1 "Data lifecycle" already designs it; the paid tier is a config value, not a feature to build    |
| **devices**           | one free, several paid. Cheap to enforce at the endpoint table, and multi-device is a power signal |
| **seats**             | only at the team tier, and only once §1's owner-scoping lands — that is what makes a seat real     |

Retention is the most interesting one because it is the only lever where the
paid version is _cheaper for us to deliver than the free version is to refuse_.
Everything else is a limit; retention is a dial that already exists.

**No numbers here on purpose.** Pick them from measured cost per session once M3a
is journaling real multi-tenant traffic. Anything chosen now would be a guess
dressed as a decision, and the M2 sample is one operator's reviews.

One thing worth deciding early, though: **the free tier should be limited by
usage, never by security.** Owner-scoped endpoints, signed envelopes and the
read-only floor are not upsells. A free tier that is less safe is a free tier
that eventually becomes an incident with our name on it.

## The open/closed line

Already half-drawn: `@symma/protocol` and `@symma/client` are MIT on npm.
`gateway` and `companion` are private today, and the two should not stay on the
same side.

| package     | proposed   | why                                                                                                    |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `protocol`  | **open**   | already is. A wire protocol nobody can read is a wire protocol nobody adopts                           |
| `client`    | **open**   | already is. It is how a consumer dials us; closing it would make integration a support ticket          |
| `companion` | **open**   | the argument below                                                                                     |
| `gateway`   | **closed** | §"The bet": the defendable product is the multi-user identity and rendezvous layer. This is that layer |

### The companion should be open, and the reason is not generosity

We ask people to run a binary on their own laptop that holds their agent
credentials and spawns processes with them. §3 already treats `curl | sh` plus
self-update as a supply-chain boundary and answers it with signed artifacts,
unprivileged install and a pinned update channel. **Signed and readable is a
materially stronger answer than signed alone**, and it is the same reason
Tailscale open-sourced its client rather than only its protocol.

There is a second reason: the companion is where every integration bug will be
diagnosed, on machines we cannot see, in agent setups we did not anticipate. A
user who can read `resolveAgent` can tell us what it did. A user who cannot will
file "it doesn't work".

### The gateway staying closed is not a moat, and should not be sold as one

Headscale is the whole lesson. Tailscale's client is open and the protocol
documented, so someone reimplemented the control plane — competently, under
BSD-3, maintained by a person Tailscale employs. Closing the gateway buys time
and raises effort. It does not prevent a reimplementation by anyone who wants
one badly enough.

What actually holds is the hosted service: the operational burden of running a
relay with real uptime, the retained journals people have accumulated, and the
Slack-side identity mapping that only matters when it is _running_. That is worth
saying out loud, because it changes the decision if we are ever tempted to close
the protocol too. Closing the protocol would cost adoption and buy nothing the
gateway does not already buy.

## Repo structure

The current monorepo cannot go public selectively — one repo, one visibility.

**Today**

```
pgup-ai/symma  (private)
├── packages/protocol     → npm, MIT, public
├── packages/client       → npm, MIT, public
├── packages/companion    → private
└── packages/gateway      → private
```

**Proposed**

```
pgup-ai/symma  (PUBLIC, MIT)          pgup-ai/symma-gateway  (private)
├── packages/protocol   → npm         ├── src/                relay, journal,
├── packages/client     → npm         │                       viewer, HTTP API,
├── packages/companion  → npm as      │                       tenancy
│                         `symma`     ├── deploy/             systemd, Caddy
├── docs/design/                      └── test/               unit + the
├── docs/strategy/                                            cross-component e2e
└── AGENTS.md
                                      depends on @symma/protocol at an exact
                                      pin from npm — the same contract every
                                      other consumer gets
```

Two repos, no submodules, no filtered mirror. A private submodule inside a public
repo is a permissions puzzle for every contributor, and a filtered public mirror
means rewriting history on every push and having nowhere for a contributor PR to
land.

The gateway consuming `@symma/protocol` from npm rather than from a workspace is
a feature: it eats the same packaging we hand everyone else, so a broken publish
breaks _us_ first. That is the check `verify:pack` exists for, applied by
default.

### The one real cost, and it is already visible

`client` and `companion` both list `@symma/gateway` as a devDependency, because
their e2e tests spawn a real gateway:

- `packages/client/test/remote.test.ts` — prompt through gateway + companion
- `packages/companion/test/companion.test.ts` — full relay e2e

Split the repos and those two tests cannot run in the public one. Three ways out,
and only one is honest:

1. **Move the cross-component e2e into the private gateway repo.** They test the
   gateway's contract with a companion, so they belong where the gateway is. The
   public repos keep their unit tests and the seams they own.
2. Ship a stub relay in `protocol` for tests. Now the public suite passes against
   something that is not the gateway, which is worse than not testing it.
3. Skip when the gateway is absent. Silent coverage loss — the failure mode this
   repo has been bitten by twice already.

Take (1). Same call as the jbot-review test split in §8 — "what a consumer keeps
is the seam it owns" — with the cross-component test living where the contract
is defined.

The cost is real and worth naming: **the public repo can no longer prove the
companion works end to end.** That check moves to private CI, which means an
outside contributor's PR gets a green public suite and still needs our run before
merge. Say so in `CONTRIBUTING.md` rather than letting people discover it.

## Licensing and contributions

- **MIT is already shipped** for `protocol` and `client`. Keep it for
  `companion`; a split license across packages a user installs together is
  friction with no return.
- **Apache-2.0 is the alternative worth one conversation**, for its explicit
  patent grant. It is more defensive for a company, and the moment to switch is
  now — while every contributor is us. After outside contributions it needs their
  agreement.
- **A CLA or DCO is needed before the first outside PR**, not after. Without one,
  code contributed to the open companion cannot later move into the closed
  gateway. That is not hypothetical: `relay-control.ts` and `envelope.ts` both
  moved into `protocol` from elsewhere once their consumer count grew, and
  movement in the other direction is exactly what a CLA covers.

## Open questions

1. **When to flip the repo public.** Not before §1's tenancy work: the public
   repo would document that `openSession` does not check ownership, which is a
   published exploit against our own running gateway.
2. **Does the companion publish as unscoped `symma`?** The name is secured. It
   reads well for `npx symma` and for a `curl | sh` binary, but it also claims
   the whole product name for one component.
3. **Free-tier numbers**, blocked on M3a cost data as above.
4. **Whether the viewer is open.** It ships inside the gateway today as a single
   HTML string. It is also the part a user is most likely to want to self-host
   against their own journals.
