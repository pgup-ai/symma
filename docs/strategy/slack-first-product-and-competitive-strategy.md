# Symma: Slack-First Product and Competitive Strategy

- **Last verified:** 2026-07-29
- **Status:** strategy reference, not a product commitment
- **Evidence boundary:** repository and package state are verified facts; market
  demand, retention, willingness to pay, and expansion thresholds are
  hypotheses until measured.

## 1. Executive summary

The Slack-first thesis is directionally right, but Slack should be Symma's
initial workflow surface rather than its permanent product boundary.

Slack gives Symma an existing social graph, established team habits, enterprise
administration, and a place where engineering work already begins. Requiring a
company to replace Slack before it can use personal agents would add a much
larger adoption problem than Symma currently needs to solve.

The thesis has two important corrections:

1. Public evidence supports calling Slack a large and deeply embedded
   enterprise ecosystem, not necessarily the collaboration product with the
   largest user base.
2. Slack is both a distribution channel and a platform risk. Its own agent
   product, API constraints, Marketplace policy, and ability to change
   commercial access can compress Symma's opportunity.

The recommended category is:

> **A personal-agent control plane for engineering teams.**

The product promise is:

> Each engineer can work with their own coding agent from Slack, on their own
> machine, workspace, subscriptions, and credentials, with private review,
> explicit sharing, honest presence, and auditable ownership boundaries.

This is more defensible than "an AI bot for Slack" or "ACP in Slack." Agent
transport and model compatibility will commoditize. Symma's potential
differentiator is the authorization and coordination contract:

`Slack actor -> authenticated owner -> owner's companion -> owner's machine,
workspace, credentials, and selected agent`

The near-term strategy should be a custom/internal Slack app with a small number
of design partners. Marketplace eligibility must be treated as a release gate,
not assumed. Symma should verticalize only after retained behavior clusters
around a repeatable workflow.

## 2. Current product reality

### Shipped and usable

- `@symma/protocol@0.3.0` and `@symma/client@0.3.0` are published.
- The companion CLI is published as `symma@0.1.0`.
- ACP framing, JSON-RPC session driving, local and gateway-routed prompt
  execution, agent specifications, credential detection, and read-only
  enforcement exist.
- The relay, retained journals, signed envelopes, viewer, and resumable
  connection foundations have been extracted and dogfooded through
  jbot-review.
- Owner-scoped gateway tenancy is implemented: users, endpoints, credentials,
  sessions, endpoint listing, journal reads, and live-session access are
  ownership-bound.
- One-command pairing, persisted companion identity, token rotation and
  revocation foundations are implemented.
- The companion detects supported local agents, reconnects, distinguishes
  explicit quit from sleep/offline behavior, and can run as a user-session
  service.

These are technical foundations. They do not prove customer adoption,
multi-organization production use, retention, or revenue.

### In active development or release hardening

- Signed installation and update experience.
- Broader real-machine validation across login shells, operating systems,
  credential stores, sleep/reboot, and network transitions.
- Operational packaging for a low-support design-partner pilot.
- Reconciliation between the extracted Symma gateway and any remaining
  jbot-review gateway behavior.

### Planned

- `@symma/slack`.
- Slack user-to-owner enrollment and a Slack-driven pairing flow.
- Durable mapping from a Slack DM thread to a Symma conversation.
- A bounded source-thread context snapshot.
- Private-by-default substantive output.
- Explicit per-task share-back to the source thread.
- Slack event idempotency, retries, agent selection, and offline/refusal UX.
- Multi-workspace OAuth and an approved public distribution path.

There is not yet a user-facing Slack product to sell or measure.

### Exploratory

- Pricing based on sessions, relayed traffic, devices, and journal retention.
- Open-companion/closed-hosted-gateway packaging.
- Enterprise SSO, SCIM, DLP, regional retention, audit export, and support
  commitments.
- Workflow verticals and a standalone agent-native interface.

## 3. Assessment of the Slack-first thesis

### Strongest arguments for it

- The collaboration graph already exists: users, channels, threads, norms, and
  administrative ownership do not need to be recreated.
- Slack is already where incidents, product decisions, GitHub links, customer
  reports, and requests for help surface.
- A bot or native Slack surface has much lower behavioral switching cost than a
  new collaboration workspace.
- Slack can provide the initial context, actor identity, and deliberate
  share-back destination without moving the agent or its credentials into a
  shared cloud account.
- A narrow workflow can be piloted through customer-managed installations before
  Symma builds a broad application surface.

### Strongest arguments against it

- Slack's interaction model is message-oriented. Long-running tasks, tool
  approvals, parallel agents, artifacts, task state, and structured handoffs do
  not fit naturally into a single thread.
- Slack can bundle increasingly capable native agents and privileged workspace
  context.
- Slack owns API policy, scopes, rate limits, review, distribution, and
  commercial terms.
- Marketplace guidance may conflict with products that enable remote execution
  through a downloadable local component. Socket Mode is useful for internal
  pilots but must not be assumed to be the public distribution route.
- A Slack-first product can easily be perceived as another bot unless it
  produces a concrete outcome that existing assistants cannot.
- Starting in Slack may bias discovery toward conversational workflows even
  when the durable value is a task, code change, incident timeline, or review
  artifact.

### Hidden assumptions to test

- Teams want to invoke personal local agents from Slack rather than open the
  native agent interface.
- The context saved by starting in Slack is worth the setup and security review.
- Private-by-default review does not suppress collaborative value.
- Laptop availability is high enough for the intended workflows.
- Administrators accept a local companion plus a hosted relay in the data path.
- Slack will permit an economically viable distribution model.
- A repeatable workflow emerges before the horizontal bridge becomes a
  low-margin compatibility product.

### Strategic conclusion

Use Slack as:

- the initial workflow surface;
- a source of actor identity and bounded context;
- an onboarding and acquisition channel where policy permits;
- a place to return intentionally shared results.

Do not make Slack:

- Symma's category;
- the only interface to durable runs and artifacts;
- the source of endpoint authorization;
- a dependency without a tested non-Marketplace installation path.

## 4. Competitive-landscape map

### Direct competitors and substitutes

- **LobeHub** — broad agent platform with Slack and other chat surfaces,
  cloud/self-host options, local-device routing, agent teams, and a large
  open-source ecosystem.
- **cc-connect** — open-source bridge between many chat platforms and local
  coding agents; it establishes a high compatibility baseline at zero software
  price.
- **GitHub Copilot for Slack** — engineering-workflow substitute with incumbent
  distribution and a direct path from Slack context to GitHub work.

### Slack-native AI and agent products

- Slackbot and Slack's agent platform.
- General assistants and workflow products distributed as Slack apps.
- Coding and operations integrations that initiate work from a message or
  thread.

### Agent-native collaboration replacements

- **Raft** — persistent agents, channels, DMs, threads, tasks, handoffs, and
  local computers in a new shared workspace.
- **Block Buzz** — open-source human-agent collaboration workspace with shared
  identity, workflows, Git integration, and a signed event log.

### Developer-focused agent interfaces

- Codex, Claude Code, Cursor, Gemini CLI, GitHub Copilot, and other local or
  hosted coding-agent products.
- These are also complements: Symma depends on users valuing their existing
  runtimes and subscriptions.

### Open-source agent platforms

- LobeHub, cc-connect, Buzz, OpenAB, Hoomanity, slack-acp, seam-acp, and similar
  ACP or CLI bridges.
- Their existence means transport compatibility is not sufficient
  differentiation.

### General collaboration products adding AI

- Slack, Microsoft Teams, Notion, Linear, Atlassian, GitHub, and adjacent
  systems of record.
- They can bundle AI into existing permissions and enterprise contracts.

## 5. Detailed comparison

| Product                  | Primary experience                               | Slack role                 | Agent execution                                        | Main advantage over Symma                                                              | Opening for Symma                                                                           |
| ------------------------ | ------------------------------------------------ | -------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Slackbot / Slack agents  | Native personal and connected agents in Slack    | Platform owner             | Slack/Salesforce cloud and connected agents            | Distribution, permissions, context, compliance, platform control                       | Personal local coding agents with user-owned credentials and an explicit ownership boundary |
| LobeHub                  | Agent teams across first-party and chat surfaces | Official app or custom bot | Cloud, self-hosted, and local devices                  | Broader UX, ecosystem, community, skills, and multi-surface reach                      | Make ownership the authorization invariant; signed audit and private/share consent          |
| cc-connect               | Messaging bridge to local agents                 | Socket Mode                | Operator-run local deployment                          | Many chat platforms and agents, rich commands, open source                             | Hosted owner identity, per-user machine routing, admin controls, and lower setup burden     |
| GitHub Copilot for Slack | Start coding work from Slack context             | Official integration       | GitHub cloud agent                                     | Owns the GitHub destination workflow and enterprise relationship                       | Runtime choice, local filesystem context, user subscriptions, and private review            |
| Raft                     | Agent-native shared workspace                    | Replaces Slack             | Local computers, managed runtimes, and external agents | Purpose-built multi-agent collaboration, task state, persistent identity, and handoffs | Avoid migration and preserve existing Slack habits                                          |
| Block Buzz               | Open-source human-agent workspace                | Replaces Slack             | Self-hosted relay and agent tooling                    | Sovereignty, shared signed log, Git and agent-first surfaces                           | Far lower adoption cost and personal-agent access inside existing workflows                 |

## 6. Symma's relative strengths and weaknesses

### Strengths

- Owner identity is intended to be an authorization invariant, not a routing
  preference.
- Each user can retain their own machine, workspace, runtime subscription, and
  local credentials.
- Outbound companion connectivity avoids requiring inbound access to a laptop.
- Signed envelopes, retained journals, revocation, presence, and owner-scoped
  reads are meaningful foundations for auditability.
- The transport layer is agent-agnostic and already consumed by a real
  downstream product.
- Private-by-default work plus explicit share-back creates a clear consent
  boundary.

### Weaknesses

- The Slack product does not exist yet.
- No product analytics, retained customer cohorts, or willingness-to-pay
  evidence exists.
- The gateway relays and can retain prompts, code context, reasoning, tool
  activity, and output. Symma must not claim that it never sees customer code.
- Sleeping, disconnected, or misconfigured user machines make availability
  materially less predictable than a hosted agent.
- Installation, pairing, PATH resolution, local permissions, upgrades, and
  support create more friction than a pure cloud app.
- LobeHub already demonstrates per-user local-device routing. Symma's remaining
  distinction is narrower and harder to communicate.
- Free and open-source bridges can commoditize the basic connection.
- Enterprise controls and an approved Slack distribution model are not yet
  complete.

## 7. Target audience and ICP

### Primary ICP

Slack-heavy engineering organizations with approximately 20–200 people where
developers already use local coding agents.

- **End user:** engineer or technical lead.
- **Internal champion:** developer-productivity, AI-platform, or staff engineer.
- **Economic buyer:** CTO or VP Engineering.
- **Veto stakeholders:** Slack administrator, security, IT, and legal.
- **Job to be done:** turn a Slack thread into private work on the appropriate
  engineer's local agent, then deliberately share a reviewed outcome.
- **Current alternatives:** copy context into a CLI, use a hosted coding agent,
  assign the work to a human, use cc-connect/LobeHub, or start a GitHub Copilot
  session.
- **Reason to adopt:** preserve the existing runtime, subscription, filesystem,
  and team workflow while adding identity and audit controls.
- **Primary barriers:** installation approval, security review, machine
  availability, unclear ROI, and Slack policy.
- **Expected sales motion:** founder-led, design-partner deployment; weeks
  rather than self-serve minutes until installation is standardized.

### Best initial design partners

Developer-tool startups and distributed product teams with experienced
engineers, short security cycles, and active local-agent use.

They are likely to provide fast learning, although willingness to pay may be
constrained by open-source substitutes.

### Later enterprise segment

Enterprise engineering-enablement teams may have higher willingness to pay for
governance, reliability, and auditability, but require SSO, lifecycle controls,
retention policy, DLP answers, audit export, support commitments, and a clear
Slack installation path.

### Audiences to postpone

- Support, IT, sales, HR, and general operations until a specific vertical is
  supported by retained usage.
- Organizations seeking a full collaboration-platform replacement.
- Individual consumers without a team collaboration problem.
- Customers whose primary requirement is an always-on hosted agent.

## 8. Recommended positioning

### Recommended

> Symma connects each engineer's own coding agent to the team workflow already
> happening in Slack. Work runs on the right user's machine and credentials,
> stays private while it is being reviewed, and is shared back only when the
> user chooses.

Supporting proof points:

- owner-scoped endpoint routing;
- user-controlled local credentials and subscriptions;
- explicit presence and refusal when the endpoint is unavailable;
- signed session evidence and retained journals;
- deliberate private-to-shared transition.

### Avoid

- "Another AI bot for Slack."
- "Slack, but agent-native."
- "A universal ACP bridge."
- "We never see your code."
- "Replace Slack."
- Claims of enterprise readiness before enterprise controls and deployments
  exist.

## 9. Phased product and go-to-market strategy

### Phase 1: prove one Slack-originated workflow

- Finish the M3 Slack conversation path.
- Use a custom/internal Slack app.
- Recruit three to five design-partner teams.
- Test incident diagnosis, PR follow-up, and issue-to-patch preparation.
- Deliver a concrete artifact or state change, not merely an answer.

### Phase 2: prove repeat behavior and trust

- Instrument pairing, first successful run, completion, refusal, retry,
  share-back, artifact creation, retention, and support burden.
- Compare private-by-default with direct posting.
- Run security and administrator discovery alongside the user pilot.
- Measure cost per session and retained journal before setting price.

### Phase 3: harden the coordination service

Build the controls that repeatedly unblock real customers:

- signed installer and updater;
- endpoint inventory, revoke, and rotation UX;
- SSO and administrative policy;
- audit export and retention controls;
- multi-device selection if availability is a proven problem;
- deployment and support playbooks.

### Phase 4: verticalize from observed behavior

Add workflow-specific objects, integrations, templates, approvals, and metrics
only after one use case dominates retained usage.

### Phase 5: expand interfaces only when constrained

Add another chat surface when qualified demand is lost because of the missing
surface. Build a standalone control or artifact interface when Slack is
materially limiting active retained workflows.

## 10. Now / Next / Later

### Now: 0–90 days

- Ship the Slack DM/thread experience for internal apps.
- Pass an unassisted pairing test.
- Choose a single engineering wedge through a workflow bake-off.
- Validate Slack policy and installation with administrators.
- Establish product analytics and session-cost measurement.

Suggested gates:

- at least 70% pair successfully within ten minutes;
- at least 50% of activated users complete three tasks in fourteen days;
- at least 40% week-four retained users;
- at least 30% of completed runs are shared back or converted into a work
  artifact;
- at least two customers approve the installation path.

### Next: 3–9 months

- Harden installer, updater, revoke/rotation, audit, and enterprise controls
  requested by multiple pilots.
- Improve presence, offline recovery, and multi-device behavior if availability
  is a top-three failure reason.
- Package the winning workflow and connect it to its system of record.
- Convert design partners into paid pilots.

### Later: evidence-gated

- **Vertical product:** invest when at least 40% of retained usage clusters in
  one workflow across at least three organizations and workflow-specific weekly
  retention exceeds 50%.
- **Another chat platform:** invest when at least 25% of qualified lost
  opportunities cite the unsupported platform rather than missing core value.
- **Standalone surface:** invest when at least 40% of active sessions require
  coordination or artifacts Slack cannot represent, and users voluntarily open
  the surface every week.
- **Full collaboration product:** do not invest without strong evidence that
  customers want to move a meaningful team workflow out of Slack.

## 11. Key risks and mitigations

| Risk                                      | Mitigation                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Slack policy or Marketplace ineligibility | Start with customer-managed apps, obtain written guidance, and keep Slack behind a transport boundary          |
| "Another Slack bot" perception            | Lead with a narrow outcome and the per-user ownership contract                                                 |
| Native Slack or LobeHub bundling          | Compete on trustworthy personal-agent coordination, not generic chat                                           |
| Agent infrastructure commoditization      | Treat ACP and runtime adapters as replaceable mechanism; build identity, audit, reliability, and workflow data |
| Local-machine availability                | Honest presence and refusal first; multi-device only when usage proves the need                                |
| Enterprise trust gap                      | Publish a precise data-flow model and build controls from repeated security-review blockers                    |
| Open-source price pressure                | Open the companion for trust; monetize the hosted reliable coordination and governance service                 |
| Horizontal-platform drift                 | Require workflow concentration and retention gates before adding features                                      |
| Gateway mistaken for a moat               | Build accumulated workflow state, operational reliability, customer trust, and integrations                    |
| Premature standalone UI                   | Start with a lightweight run/artifact control surface only after Slack constraints are measured                |

## 12. High-value experiments for the next 90 days

1. **Concierge M3 pilot:** three to five teams complete a real repeated workflow.
2. **Workflow bake-off:** compare incident diagnosis, PR follow-up, and
   issue-to-patch preparation.
3. **Private-by-default test:** measure trust, completion, and share-back against
   direct posting.
4. **Pairing usability:** at least eight of ten users pair in under ten minutes
   without operator intervention.
5. **Sleep/offline recovery:** at least 90% of users understand the refusal and
   recover without support.
6. **Security discovery:** determine whether owner-scoped routing and local
   credentials materially improve approval for at least two of five reviewers.
7. **Slack policy validation:** obtain written guidance or a partner-approved
   distribution route.
8. **Willingness to pay and cost metering:** secure three paid-pilot commitments
   and a measured gross-margin model before fixing price.

## 13. Final verdict

### Where Symma is most likely to win

- Slack-heavy engineering teams already using local coding agents.
- Work that starts in a team conversation but needs private execution and
  review before sharing.
- Organizations that value runtime choice and user-owned credentials but need
  stronger identity, routing, and auditability than a self-hosted bridge.
- A focused engineering workflow where Symma can deliver a concrete artifact.

### Where Symma is unlikely to win

- Replacing Slack as a general collaboration platform.
- Generic multi-agent chat against Raft, Buzz, or LobeHub.
- A compatibility race against free open-source bridges.
- Always-on hosted-agent workloads when customer laptops are the execution
  substrate.
- Enterprise-wide rollout before administrative and security controls exist.

### What to focus on now

- Finish the actual Slack product.
- Prove one repeated engineering outcome.
- Make pairing and offline behavior trustworthy.
- Validate the commercial Slack installation path.
- Instrument behavior before selecting a vertical.

### What to avoid

- Building a standalone collaboration platform now.
- Supporting every chat surface or agent runtime for its own sake.
- Pricing before usage cost and willingness to pay are measured.
- Broad privacy claims that the gateway architecture cannot support.
- Treating Slack distribution, ACP transport, or closed gateway code as the
  moat.

## Appendix A: Raft package implementation findings

Reviewed on 2026-07-29:

- [`@botiverse/raft@0.0.17`](https://www.npmjs.com/package/@botiverse/raft)
- [`@botiverse/raft-daemon@1.0.14`](https://www.npmjs.com/package/@botiverse/raft-daemon)
- [Raft external-agent documentation](https://docs.raft.build/features/agents/external/)

### Correction: Raft does not carry Slack context

Raft is a Slack replacement, not a Slack client. The context shared by its
agents is Raft-native channel, DM, thread, message, attachment, task, reminder,
membership, and search state.

### The published `@botiverse/raft` package is an agent-facing CLI

It does not spawn the managed coding agents and contains no ACP implementation.
It provides two authentication modes:

1. A daemon-spawned managed runner receives agent identity, server identity, a
   localhost proxy URL, and a short-lived token through injected environment
   variables.
2. An external agent completes a device-authorization flow and stores a
   profile-scoped agent credential selected with `RAFT_PROFILE`.

Both modes call a Raft HTTP Agent API. Requests carry a bearer credential plus
agent and server identity headers. Capabilities can be restricted per agent.

### External-agent wake path

The long-lived `raft agent bridge`:

1. opens an SSE wake-hint stream;
2. falls back to polling when streaming is unavailable;
3. persists a per-agent cursor and pending content-free wake hints;
4. injects a wake into a localhost runtime plugin;
5. records delivery proofs and retries/reconciles unconfirmed hints.

Wake hints omit message bodies. After waking, the agent uses `raft message
check`, `raft message read`, or `raft message search` to retrieve authorized
context and uses `raft message send` to reply.

The current external Claude path uses a dedicated Claude Code channel plugin
with a localhost wake endpoint. This is not ACP.

### Managed-runtime connection strategy

The daemon uses runtime-specific drivers rather than one universal protocol:

- Claude Code is launched through its native CLI/streaming interface.
- Codex is controlled through Codex app-server JSON-RPC.
- Other supported CLIs and SDKs have their own adapters.
- The inspected daemon uses ACP version 1 for the Grok Build driver:
  `initialize`, `session/new` or `session/load`, `session/prompt`, and a
  proprietary busy-turn interjection method.

Therefore, Raft's breadth comes from maintaining an adapter matrix. ACP is one
adapter, not the platform's internal collaboration protocol.

### How Raft coordinates multiple agents

The server is the collaboration source of truth:

- agents have persistent identities, memberships, workspaces, and runtime
  sessions;
- joined-channel messages generate delivery, while mentions direct attention;
- a thread mention can include the parent message and bounded recent thread
  context;
- an inbox notice summarizes changed targets, pending counts, latest sender,
  message IDs, and attention flags without necessarily injecting bodies;
- agents explicitly pull message history, bounded around message IDs or
  sequence cursors;
- tasks have server-side claim and status transitions, preventing multiple
  agents from silently doing the same work;
- task work continues in the source message's thread;
- send, claim, and task-update operations can be held when newer unseen context
  exists.

That last mechanism is strategically important. Raft tracks what an agent has
seen per target. If another human or agent posts newer information before a
side effect, the server can hold the action, show bounded fresh context, save a
draft, and require the agent to reconsider. This is a stronger collaboration
primitive than merely appending more chat history to a model prompt.

### Implications for Symma

1. Do not copy Raft's full adapter matrix now. Symma's ACP-first boundary keeps
   the platform smaller and should remain valuable until a required runtime
   cannot provide adequate ACP behavior.
2. Separate wake notification from message content. A content-free wake plus an
   authorized context fetch is easier to retry, deduplicate, and audit.
3. Add explicit per-conversation "seen through" cursors before allowing
   multi-agent writes or share-back. Freshness checks can prevent stale answers
   and duplicate work.
4. Treat task claims and artifact ownership as server-side coordination state,
   not prompt conventions.
5. Preserve exact reply targets so an agent cannot accidentally leak thread or
   DM context into another surface.
6. If Symma later supports multi-agent collaboration, start with bounded context
   pull, task claim, handoff, and freshness semantics rather than injecting an
   entire Slack history into every agent.

## Sources

- [Symma M3 design](../design/m3-slack-companion.md)
- [Symma open-core strategy](open-core.md)
- [Slack company facts](https://slack.com/intl/en-sg/about)
- [Slack integrations](https://api.slack.com/integrations)
- [Slack AI apps](https://api.slack.com/docs/apps/ai)
- [Slack Marketplace guidelines](https://api.slack.com/docs/slack-apps-guidelines)
- [Block Buzz](https://github.com/block/buzz)
- [Raft](https://raft.build/)
- [Raft documentation](https://docs.raft.build/)
- [cc-connect](https://github.com/chenhg5/cc-connect)
- [LobeHub for Slack](https://lobehub.com/fr/lobehub-for-slack)
- [GitHub for Slack and Copilot](https://docs.github.com/en/integrations/how-tos/slack/integrate-github-with-slack)
