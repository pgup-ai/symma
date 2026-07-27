# @symma/client

Drives one ACP prompt against an agent — spawned locally, or hosted by a remote
companion and reached through a symma gateway. Same session logic either way;
only the transport differs.

Part of [symma](https://github.com/pgup-ai/symma). Node 20+, ESM only.

```bash
npm i @symma/client
```

```ts
import { runLocalAcpPrompt, checkEndpointReady, runRemotePrompt } from '@symma/client';

// local: spawn the agent on this machine
const text = await runLocalAcpPrompt(spec, workspace, model, prompt, 'review', log);

// remote: through a gateway to someone's companion
await checkEndpointReady(config, 'kilo');
const remote = await runRemotePrompt({ ...config, agent: 'kilo' }, model, prompt, 'review', log);
```

`checkEndpointReady` fails fast when the endpoint cannot serve the session, so a
sleeping laptop or an unoffered agent surfaces before the prompt rather than
minutes into it.
