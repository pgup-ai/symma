# @symma/protocol

ACP framing, the JSON-RPC peer, session driving, agent specs with their
credential helpers, the read-only permission floor, signed envelopes and relay
control types.

Part of [symma](https://github.com/pgup-ai/symma). Node 20+, ESM only.

```bash
npm i @symma/protocol
```

```ts
import { driveAcpSession, respondToPermissionRequest } from '@symma/protocol';

const { text, stopReason } = await driveAcpSession(
  { input: child.stdin, output: child.stdout },
  { cwd, prompt, agent: 'kilo', label: 'review', log: console.log },
);
```

`driveAcpSession` takes a stream pair and drives one prompt to its final
assistant message. It sets no deadline of its own: transport death rejects, and
the caller owns timeouts. Pass `tee` to observe every frame in both directions.

Mutating tool kinds are rejected by `respondToPermissionRequest`, the
client-side layer of symma's read-only floor.
