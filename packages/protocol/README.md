# @symma/protocol

ACP framing, the JSON-RPC peer, session driving, agent specs with their
credential helpers, the read-only permission floor, signed envelopes and relay
control types.

Part of [symma](https://github.com/pgup-ai/symma). Node 20+, ESM only.

```bash
npm i @symma/protocol
```

```ts
import { driveAcpSession, kiloAcpSpec } from '@symma/protocol';

const spec = kiloAcpSpec(auth);
const { text, stopReason } = await driveAcpSession(
  { input: child.stdin, output: child.stdout },
  {
    cwd,
    prompt,
    agent: spec.id,
    label: 'review',
    log: console.log,
    // Carry the spec's policy through. kilo has no OS sandbox, so plan mode is
    // its read-only layer, and this makes the session refuse to run without it.
    requirePlanMode: spec.requirePlanMode,
  },
);
```

`driveAcpSession` takes a stream pair and drives one prompt to its final
assistant message. It sets no deadline of its own: transport death rejects, and
the caller owns timeouts. Pass `tee` to observe every frame in both directions.

Read-only rests on three layers, and only the first is unconditional here:
`respondToPermissionRequest` rejects mutating tool kinds, an agent-side sandbox
covers agents that have one, and plan mode covers those that do not. Bash stays
allowed by design, so **an agent without a sandbox is only read-only inside plan
mode** — pass `requirePlanMode` from its spec rather than hardcoding options.

`@symma/client`'s `runLocalAcpPrompt` does all of this for you, including the
process lifecycle; reach for the raw session driver only when you own the
transport.
