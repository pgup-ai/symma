# @symma/client

Drives one ACP prompt against an agent — spawned locally, or hosted by a remote
companion and reached through a symma gateway. Same session logic either way;
only the transport differs.

Part of [symma](https://github.com/pgup-ai/symma). Node 20+, ESM only.

**0.2.0 breaks `runLocalAcpPrompt`.** Its trailing `timeoutMs` became an options
bag, `{ timeoutMs, tee }`. TypeScript callers get a compile error; a JavaScript
caller still passing a bare number gets the default timeout and no warning.

```bash
npm i @symma/client @symma/protocol
```

The agent spec comes from `@symma/protocol`, which is why both are installed.

```ts
import { readFile } from 'node:fs/promises';

import { kiloAcpSpec } from '@symma/protocol';
import { checkEndpointReady, runLocalAcpPrompt, runRemotePrompt } from '@symma/client';

// Local: spawn the agent on this machine.
const spec = kiloAcpSpec(await readFile(kiloAuthPath, 'utf8'));
const local = await runLocalAcpPrompt(spec, workspace, 'kilo/default', prompt, 'review', log, {
  // Optional: observe every frame in both directions.
  tee: (dir, frame) => journal(dir, frame),
});

// Remote: through a gateway to someone else's companion.
const config = { gateway, token, endpoint: 'laptop', runId: 'run-1' };
await checkEndpointReady(config, 'kilo');
const remote = await runRemotePrompt(
  { ...config, agent: 'kilo' },
  'kilo/default',
  prompt,
  'review',
  log,
);
```

Both return the agent's final assistant message.

`checkEndpointReady` fails fast when the endpoint cannot serve the session, so a
sleeping laptop or an unoffered agent surfaces before the prompt rather than
minutes into it.
