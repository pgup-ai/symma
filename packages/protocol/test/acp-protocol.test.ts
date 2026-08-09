import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  claudeAcpSpec,
  codexAcpSpec,
  createNdjsonReader,
  cursorAcpSpec,
  devinAcpSpec,
  driveAcpSession,
  geminiAcpSpec,
  geminiOauthPath,
  kiloAcpSpec,
  matchModelOptionValue,
  opencodeAcpSpec,
  opencodeAuthPath,
  isWriteCapableMode,
  respondToPermissionRequest,
} from '../src/acp-protocol.js';
import { codexAuthPath } from '../src/codex.js';
import { devinCredentialsPath } from '../src/devin.js';

const noLog = (): void => undefined;

interface FakeAgentApi {
  update: (update: Record<string, unknown>) => void;
  request: (id: number, method: string, params: Record<string, unknown>) => void;
  finish: (stopReason?: string, usage?: Record<string, unknown>) => void;
}

interface FakeAgentScript {
  modes?: Record<string, unknown>;
  models?: Record<string, unknown>;
  configOptions?: unknown[];
  authMethods?: unknown[];
  /** First session/new fails -32000 until authenticate is called. */
  authGate?: boolean;
  capabilities?: Record<string, unknown>;
  /** What the agent says it can be handed with a prompt. */
  promptCapabilities?: Record<string, unknown>;
  /** Every prompt block the agent received, for asserting what travelled. */
  onPromptBlocks?: (blocks: Record<string, unknown>[]) => void;
  /** Answers session/load. Returning an error is an agent that has forgotten
   * the session; the replay it would otherwise send is the script's to write. */
  onLoad?: (agent: FakeAgentApi, authed: boolean) => Record<string, unknown>;
  onPrompt: (agent: FakeAgentApi, prompt: string) => void;
  onClientResponse?: (id: number, result: unknown, agent: FakeAgentApi) => void;
}

/** Scripted ACP agent over PassThrough streams: answers the handshake and
 * hands prompt-turn control to the script. */
function fakeAgentIo(script: FakeAgentScript): {
  input: PassThrough;
  output: PassThrough;
  setModeIds: string[];
  setModelIds: string[];
  setConfigCalls: unknown[];
  authCalls: unknown[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const setModeIds: string[] = [];
  const setModelIds: string[] = [];
  const setConfigCalls: unknown[] = [];
  const authCalls: unknown[] = [];
  let authed = false;
  let promptId: unknown;
  const send = (message: Record<string, unknown>): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const agent: FakeAgentApi = {
    update: (update) =>
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update },
      }),
    request: (id, method, params) => send({ jsonrpc: '2.0', id, method, params }),
    finish: (stopReason = 'end_turn', usage?: Record<string, unknown>) =>
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason, ...(usage ? { usage } : {}) } }),
  };
  const read = createNdjsonReader((message) => {
    const { id, method } = message as { id?: number; method?: string };
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          ...(script.authMethods ? { authMethods: script.authMethods } : {}),
          // Nested where the spec and codex-acp both put it — a fake that
          // flattened this is what let the driver read the wrong level.
          ...(script.capabilities || script.promptCapabilities
            ? {
                agentCapabilities: {
                  ...script.capabilities,
                  ...(script.promptCapabilities
                    ? { promptCapabilities: script.promptCapabilities }
                    : {}),
                },
              }
            : {}),
        },
      });
    } else if (method === 'authenticate') {
      authCalls.push(message.params);
      authed = true;
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'session/new' && script.authGate && !authed) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'Authentication required' },
      });
    } else if (method === 'session/new') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId: 's1',
          ...(script.modes ? { modes: script.modes } : {}),
          ...(script.models ? { models: script.models } : {}),
          ...(script.configOptions ? { configOptions: script.configOptions } : {}),
        },
      });
    } else if (method === 'session/load') {
      const answer = script.onLoad?.(agent, authed) ?? { result: {} };
      send({ jsonrpc: '2.0', id, ...answer });
    } else if (method === 'session/set_config_option') {
      setConfigCalls.push(message.params);
      const params = message.params as { configId?: string; value?: string };
      send({
        jsonrpc: '2.0',
        id,
        result: {
          configOptions: [{ id: params.configId, currentValue: params.value }],
        },
      });
    } else if (method === 'session/set_mode') {
      setModeIds.push((message.params as { modeId?: string })?.modeId ?? '');
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'session/set_model') {
      setModelIds.push((message.params as { modelId?: string })?.modelId ?? '');
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'session/prompt') {
      promptId = id;
      const blocks = (message.params as { prompt?: { text?: string }[] }).prompt ?? [];
      script.onPromptBlocks?.(blocks as Record<string, unknown>[]);
      script.onPrompt(agent, blocks.map((block) => block.text ?? '').join(''));
    } else if (method === undefined && id !== undefined) {
      script.onClientResponse?.(id, (message as { result?: unknown }).result, agent);
    }
  });
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => read(chunk));
  return { input, output, setModeIds, setModelIds, setConfigCalls, authCalls };
}

/** A pid nothing holds, asked for rather than hard-coded: Linux `pid_max` can
 * sit far above any constant worth writing, and a fixture that assumes one is
 * flaky on exactly the long-uptime machine that would expose it. */
function unusedPid(from: number): number {
  for (let pid = from; pid < from + 200; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      // EPERM is a live process under another user; only ESRCH is nobody.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error(`no unused pid between ${String(from)} and ${String(from + 200)}`);
}

describe('acp', () => {
  it('parses newline-delimited frames split across chunks and skips banner noise', () => {
    const seen: unknown[] = [];
    const read = createNdjsonReader((message) => seen.push(message));
    read('starting agent v1.2\n{"a"');
    read(':1}\n{"b":2}\n\n{"c"');
    read(':3}\n');
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    // Oversized frame trips the budget and latches the reader off.
    const capped = createNdjsonReader(() => undefined, 8);
    assert.equal(capped('{"x":"aaaaaaaaaa'), false);
    assert.equal(capped('"}\n'), false);
    // Same budget applies when the newline lands in the same chunk.
    const oneShot: unknown[] = [];
    const capped2 = createNdjsonReader((message) => oneShot.push(message), 8);
    assert.equal(capped2('{"x":"aaaaaaaaaa"}\n'), false);
    assert.deepEqual(oneShot, []);
  });

  it('caps frames by UTF-8 bytes, not UTF-16 code units', () => {
    // Same code-unit length, different verdict: 13 ASCII chars are 13 bytes
    // and fit a 16-byte budget, while 13 code units of CJK are 23 bytes and
    // must not. Counting `.length` would admit both.
    const seen: unknown[] = [];
    const reader = createNdjsonReader((message) => seen.push(message), 16);
    assert.equal(reader('{"a":"bcdef"}\n'), true);
    assert.deepEqual(seen, [{ a: 'bcdef' }]);
    assert.equal(reader('{"a":"日本語日本"}\n'), false);
    // Latches off, and the multibyte frame never reached the callback.
    assert.deepEqual(seen, [{ a: 'bcdef' }]);

    // The unterminated-buffer path is measured the same way.
    const buffered = createNdjsonReader(() => undefined, 16);
    assert.equal(buffered('{"a":"日本語日本"'), false);
  });

  it('fails pending requests when the transport dies instead of hanging', async () => {
    const options = { cwd: '/x', prompt: 'p', agent: 'fake', label: 'review', log: noLog };
    // Nothing answers `initialize`; ending stdout must reject, not hang. The
    // caller's own deadline is policy on top of this, not a substitute for it.
    const output = new PassThrough();
    const pending = driveAcpSession({ input: new PassThrough(), output }, options);
    output.end();
    await assert.rejects(pending, /agent stdout (ended|closed) mid-request/);

    // A stream fault rejects the session rather than throwing an unhandled
    // 'error' event at the process.
    const faulted = new PassThrough();
    const onFault = driveAcpSession({ input: new PassThrough(), output: faulted }, options);
    faulted.destroy(new Error('pipe reset'));
    await assert.rejects(onFault, /agent stdout (failed|closed) mid-request/);

    // An unwritable stdin drops the frame, so the request it belongs to can
    // never be answered — reject at send time.
    const input = new PassThrough();
    input.destroy();
    await assert.rejects(
      driveAcpSession({ input, output: new PassThrough() }, options),
      /agent stdin is not writable; initialize was not sent/,
    );
  });

  // execute-allow and unknown-kind-allow are the DESIGNED policy of the
  // read-only floor (bash stays allowed; the agent-side sandbox and plan mode
  // police commands), so this test pins them on purpose.
  it('hands every frame to the tee, in both directions', async () => {
    // The tee is injected rather than built here, so nothing on either side of
    // the boundary proves it is still called — a consumer passes one and its
    // suite would stay green if this stopped firing.
    const teed: [string, string | undefined][] = [];
    const fake = fakeAgentIo({
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        });
        agent.finish();
      },
    });
    await driveAcpSession(
      { input: fake.input, output: fake.output },
      {
        cwd: '/x',
        prompt: 'p',
        agent: 'fake',
        label: 'review',
        log: noLog,
        tee: (dir, frame) => teed.push([dir, frame.method as string | undefined]),
      },
    );
    assert.deepEqual(
      teed.filter(([, method]) => method === 'initialize'),
      [['out', 'initialize']],
      'client frames are teed outbound',
    );
    assert.ok(
      teed.some(([dir, method]) => dir === 'in' && method === 'session/update'),
      'agent frames are teed inbound',
    );
    // A relayed caller passes none, and that must stay a no-op rather than throw.
    const quiet = fakeAgentIo({ onPrompt: (agent) => agent.finish() });
    await driveAcpSession(
      { input: quiet.input, output: quiet.output },
      { cwd: '/x', prompt: 'p', agent: 'fake', label: 'review', log: noLog },
    );
  });

  it('carries a refusal back too, since the floor made that call as well', async () => {
    // Read-only denies a write, and an agent told no often answers around it
    // rather than saying which door was shut — so the caller is told which.
    const fake = fakeAgentIo({
      onPrompt: (agent) =>
        agent.request(9, 'session/request_permission', {
          toolCall: { kind: 'edit', title: 'Write src/index.ts' },
          options: [
            { optionId: 'ao', kind: 'allow_once' },
            { optionId: 'ro', kind: 'reject_once' },
          ],
        }),
      onClientResponse: (_id, _result, agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'no' },
        });
        agent.finish();
      },
    });
    const result = await driveAcpSession(fake, {
      cwd: '/tmp',
      prompt: 'p',
      agent: 'fake',
      label: 't',
      log: noLog,
    });
    assert.deepEqual(result.approvals, [{ title: 'Write src/index.ts', allowed: false }]);
  });

  it('takes a token count only where it could be one', async () => {
    // The wire is an agent's word for what a turn cost, and a caller cannot tell
    // a real figure from a nonsense one — so the ones that cannot be true are
    // dropped here rather than passed on for every consumer to re-check.
    const drive = async (usage: Record<string, unknown>): Promise<unknown> => {
      const fake = fakeAgentIo({ onPrompt: (agent) => agent.finish('end_turn', usage) });
      return (
        await driveAcpSession(
          { input: fake.input, output: fake.output },
          { cwd: '/x', prompt: 'p', agent: 'fake', label: 'review', log: noLog },
        )
      ).usage;
    };
    assert.deepEqual(await drive({ totalTokens: 900, cachedReadTokens: 400 }), {
      totalTokens: 900,
      cachedTokens: 400,
    });
    // More cached than the total it is part of: the total stands, the cache
    // figure goes, and nothing downstream discounts a turn by it.
    assert.deepEqual(await drive({ totalTokens: 900, cachedReadTokens: 1200 }), {
      totalTokens: 900,
    });
    assert.equal(await drive({ totalTokens: -5, cachedReadTokens: -1 }), undefined);
    // Nor a fraction of a token, which is not a thing either.
    assert.equal(await drive({ totalTokens: 1.5, cachedReadTokens: 0.5 }), undefined);
  });

  it('introduces itself as the library, not as a consumer', async () => {
    // Once shipped a downstream product's name — true of the repo this was
    // extracted from, false for everyone else, and invisible because no test
    // looked at what the handshake claims. The only place it names itself.
    let intro: unknown;
    const fake = fakeAgentIo({ onPrompt: (agent) => agent.finish() });
    await driveAcpSession(
      { input: fake.input, output: fake.output },
      {
        cwd: '/x',
        prompt: 'p',
        agent: 'fake',
        label: 'review',
        log: noLog,
        tee: (_dir, frame) => {
          if (frame.method === 'initialize')
            intro = (frame.params as { clientInfo?: unknown }).clientInfo;
        },
      },
    );
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    assert.deepEqual(intro, { name: pkg.name, version: pkg.version });
    // Both sides read package.json, so that alone would hold for any pair of
    // values — including the empty ones a broken read produces. These pin what
    // the pair has to be.
    assert.match(pkg.name, /^@symma\//);
    assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  });

  it('answers permission requests read-only: mutations rejected, reads/exec allowed', () => {
    const options = [
      { optionId: 'aa', kind: 'allow_always' },
      { optionId: 'ao', kind: 'allow_once' },
      { optionId: 'ro', kind: 'reject_once' },
    ];
    assert.deepEqual(respondToPermissionRequest({ toolCall: { kind: 'execute' }, options }), {
      outcome: { outcome: 'selected', optionId: 'ao' },
    });
    assert.deepEqual(respondToPermissionRequest({ toolCall: { kind: 'edit' }, options }), {
      outcome: { outcome: 'selected', optionId: 'ro' },
    });
    // Hyphenated kinds (cursor) normalize; *_always is the same-direction fallback.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: { kind: 'delete' },
        options: [
          { optionId: 'ra', kind: 'reject-always' },
          { optionId: 'aa', kind: 'allow-always' },
        ],
      }),
      { outcome: { outcome: 'selected', optionId: 'ra' } },
    );
    // Missing kind defaults to allow — read tools commonly ship kind "other" or none.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: {},
        options: [{ optionId: 'ao', kind: 'allow_once' }],
      }),
      { outcome: { outcome: 'selected', optionId: 'ao' } },
    );
    // switch_mode is denied: the caller sets the session mode; approving one would
    // let a prompt-injected switch escape the plan-mode read-only layer.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: { kind: 'switch_mode' },
        options,
      }),
      {
        outcome: { outcome: 'selected', optionId: 'ro' },
      },
    );
    // A denied tool with only allow options gets the cancelled outcome, never an allow.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: { kind: 'edit' },
        options: [{ optionId: 'aa', kind: 'allow_always' }],
      }),
      { outcome: { outcome: 'cancelled' } },
    );
  });

  it('answers permission requests for a write-mode session: everything but switch_mode', () => {
    const options = [
      { optionId: 'aa', kind: 'allow_always' },
      { optionId: 'ao', kind: 'allow_once' },
      { optionId: 'ro', kind: 'reject_once' },
    ];
    assert.deepEqual(
      respondToPermissionRequest({ toolCall: { kind: 'edit' }, options }, 'writes'),
      { outcome: { outcome: 'selected', optionId: 'ao' } },
    );
    // The mode channel and the prompt channel never mix: even a session whose
    // owner enabled writes cannot switch its own mode from inside.
    assert.deepEqual(
      respondToPermissionRequest({ toolCall: { kind: 'switch_mode' }, options }, 'writes'),
      { outcome: { outcome: 'selected', optionId: 'ro' } },
    );
    // `plan` is read-only-class despite not being the literal id — it is the
    // behavioral read-only layer this driver itself force-selects. Every floor
    // classifies through the shared helper, or plan would be handed writes.
    assert.equal(isWriteCapableMode('plan'), false);
    assert.equal(isWriteCapableMode('read-only'), false);
    assert.equal(isWriteCapableMode('agent'), true);
    assert.equal(isWriteCapableMode('agent-full-access'), true);
  });

  it('read-only denies MCP tool approvals whatever kind they carry', () => {
    // codex-acp 1.1.7 labels MCP approvals kind `execute` — a kind the floor
    // allows for git — with this meta flag. MCP servers run outside the OS
    // sandbox, so the floor is all that stands between a read-only session and
    // a write-capable MCP tool.
    const options = [
      { optionId: 'ao', kind: 'allow_once' },
      { optionId: 'ro', kind: 'reject_once' },
    ];
    const mcp = {
      toolCall: { kind: 'execute' },
      _meta: { is_mcp_tool_approval: true },
      options,
    };
    assert.deepEqual(respondToPermissionRequest(mcp), {
      outcome: { outcome: 'selected', optionId: 'ro' },
    });
    // A write-mode session is the member's own choice; their MCP tools run.
    assert.deepEqual(respondToPermissionRequest(mcp, 'writes'), {
      outcome: { outcome: 'selected', optionId: 'ao' },
    });
  });

  it('runs the caller-chosen mode and reports the roster', async () => {
    const permissionAnswers: unknown[] = [];
    const fake = fakeAgentIo({
      modes: {
        currentModeId: 'read-only',
        availableModes: [
          { id: 'read-only', name: 'Read-only' },
          { id: 'agent', name: 'Agent', description: 'Read and edit files.' },
        ],
      },
      onPrompt: (agent) => {
        // The driver's own floor follows the mode: a local caller that asked
        // for writes must not have this layer deny what the mode promises.
        agent.request(9, 'session/request_permission', {
          toolCall: { kind: 'edit', title: 'Write src/index.ts' },
          options: [
            { optionId: 'ao', kind: 'allow_once' },
            { optionId: 'ro', kind: 'reject_once' },
          ],
        });
      },
      onClientResponse: (_id, result, agent) => {
        permissionAnswers.push(result);
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        });
        agent.finish();
      },
    });
    const result = await driveAcpSession(fake, {
      cwd: '/tmp',
      prompt: 'p',
      agent: 'codex',
      label: 't',
      log: noLog,
      mode: 'agent',
    });
    assert.deepEqual(fake.setModeIds, ['agent']);
    assert.deepEqual(permissionAnswers, [{ outcome: { outcome: 'selected', optionId: 'ao' } }]);
    // Carried back named: the agent only asks where it would have asked a member
    // at their own terminal, and this one was answered without them.
    assert.deepEqual(result.approvals, [{ title: 'Write src/index.ts', allowed: true }]);
    assert.deepEqual(result.modes, {
      currentModeId: 'agent',
      availableModes: [
        { id: 'read-only', name: 'Read-only' },
        { id: 'agent', name: 'Agent', description: 'Read and edit files.' },
      ],
    });
  });

  it('selects a model off the roster, reports it, and narrates tool calls', async () => {
    const steps: string[] = [];
    const fake = fakeAgentIo({
      models: {
        currentModelId: 'gpt-5.6-sol[high]',
        availableModels: [
          { modelId: 'gpt-5.6-sol[high]', name: 'GPT-5.6-Sol (high)' },
          { modelId: 'gpt-5.4-mini[low]', name: 'GPT-5.4-Mini (low)' },
        ],
      },
      onPrompt: (agent) => {
        agent.update({ sessionUpdate: 'tool_call', title: 'Reading dm.ts' });
        // An update with no title of its own must not report a blank step.
        agent.update({ sessionUpdate: 'tool_call_update', status: 'completed' });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        });
        agent.finish();
      },
    });
    const result = await driveAcpSession(fake, {
      cwd: '/tmp',
      prompt: 'p',
      agent: 'codex',
      label: 't',
      log: noLog,
      model: 'codex/gpt-5.4-mini[low]',
      onProgress: (title) => steps.push(title),
    });
    // Applied by exact roster id — never by taking the id apart, so what the
    // member was shown is what runs.
    assert.deepEqual(fake.setModelIds, ['gpt-5.4-mini[low]']);
    assert.equal(result.models?.currentModelId, 'gpt-5.4-mini[low]');
    assert.deepEqual(
      result.models?.availableModels.map((m) => m.modelId),
      ['gpt-5.6-sol[high]', 'gpt-5.4-mini[low]'],
    );
    assert.deepEqual(steps, ['Reading dm.ts']);
    assert.equal(result.text, 'done');
  });

  it('sends attachments as the blocks the agent advertised, and only those', async () => {
    const sent: Record<string, unknown>[][] = [];
    const attachments = [
      { name: 'rows.csv', mimeType: 'text/csv', kind: 'text' as const, data: 'a,b' },
      { name: 'shot.png', mimeType: 'image/png', kind: 'image' as const, data: 'iVA=' },
    ];
    const drive = (promptCapabilities: Record<string, unknown>) =>
      driveAcpSession(
        fakeAgentIo({
          promptCapabilities,
          onPromptBlocks: (blocks) => sent.push(blocks),
          onPrompt: (agent) => {
            agent.update({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ok' },
            });
            agent.finish();
          },
        }),
        {
          cwd: '/tmp',
          prompt: 'what is this?',
          agent: 'codex',
          label: 't',
          log: noLog,
          attachments,
        },
      );

    await drive({ embeddedContext: true, image: true });
    // Material first, question last — the order a human would write it in.
    assert.deepEqual(sent[0], [
      {
        type: 'resource',
        resource: { uri: 'symma://attachment/rows.csv', mimeType: 'text/csv', text: 'a,b' },
      },
      { type: 'image', mimeType: 'image/png', data: 'iVA=' },
      { type: 'text', text: 'what is this?' },
    ]);

    // An agent that advertised neither is sent neither: a block it cannot read
    // would fail the whole prompt, costing the question as well as the file.
    const bare = await drive({});
    assert.deepEqual(sent[1], [{ type: 'text', text: 'what is this?' }]);
    // And names them for the caller to word: it is the one that told its member
    // they were being read, and the one that knows how its surface renders a
    // filename. A silent drop is the failure this whole path exists for.
    assert.deepEqual(bare.unsupported, [
      { name: 'rows.csv', kind: 'text' },
      { name: 'shot.png', kind: 'image' },
    ]);
    assert.deepEqual(bare.notices, []);
  });

  it('does not narrate the turn a resume replayed at it', async () => {
    const steps: string[] = [];
    const fake = fakeAgentIo({
      capabilities: { loadSession: true },
      onLoad: (agent) => {
        // What a resume replays: the previous turn's steps and its answer.
        agent.update({ sessionUpdate: 'tool_call', title: 'Reading last time' });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'the old answer' },
        });
        return { result: {} };
      },
      onPrompt: (agent) => {
        agent.update({ sessionUpdate: 'tool_call', title: 'Reading this time' });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'the new answer' },
        });
        agent.finish();
      },
    });
    const result = await driveAcpSession(fake, {
      cwd: '/tmp',
      prompt: 'p',
      agent: 'codex',
      label: 't',
      log: noLog,
      resume: 'old-session',
      onProgress: (title) => steps.push(title),
    });
    // Only this turn's step: narrating the replay would show the wrong turn
    // moving on an acknowledgement the member is watching.
    assert.deepEqual(steps, ['Reading this time']);
    assert.equal(result.text, 'the new answer');
  });

  it('encodes an attachment name into its uri', async () => {
    // A space or a `#` in a name would otherwise make a uri a stricter consumer
    // can reject, dropping the file it names.
    const sent: Record<string, unknown>[][] = [];
    await driveAcpSession(
      fakeAgentIo({
        promptCapabilities: { embeddedContext: true },
        onPromptBlocks: (blocks) => sent.push(blocks),
        onPrompt: (agent) => {
          agent.update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ok' },
          });
          agent.finish();
        },
      }),
      {
        cwd: '/tmp',
        prompt: 'p',
        agent: 'codex',
        label: 't',
        log: noLog,
        attachments: [
          { name: 'my notes #2.md', mimeType: 'text/markdown', kind: 'text', data: 'x' },
        ],
      },
    );
    assert.equal(
      (sent[0]![0] as { resource: { uri: string } }).resource.uri,
      'symma://attachment/my%20notes%20%232.md',
    );
  });

  it('leaves the model alone when the roster does not hold it', async () => {
    // The review path names models the agent takes by config or flag, not off
    // this roster; selecting one it never offered would fail the turn instead.
    const fake = fakeAgentIo({
      models: { currentModelId: 'a', availableModels: [{ modelId: 'a' }] },
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        });
        agent.finish();
      },
    });
    await driveAcpSession(fake, {
      cwd: '/tmp',
      prompt: 'p',
      agent: 'codex',
      label: 't',
      log: noLog,
      model: 'codex/not-on-the-roster',
    });
    assert.deepEqual(fake.setModelIds, []);
  });

  it('refuses a mode the agent does not offer, naming the roster', async () => {
    const fake = fakeAgentIo({
      modes: { currentModeId: 'read-only', availableModes: [{ id: 'read-only' }] },
      onPrompt: () => {
        throw new Error('must not prompt');
      },
    });
    // Silently downgrading would run a different permission tier than the one
    // the member was shown, in either direction — so the turn fails instead.
    await assert.rejects(
      driveAcpSession(fake, {
        cwd: '/tmp',
        prompt: 'p',
        agent: 'codex',
        label: 't',
        log: noLog,
        mode: 'agent',
      }),
      /mode agent not offered \(offers: read-only\)/,
    );
    assert.deepEqual(fake.setModeIds, []);
  });

  it('drives a session end-to-end and returns the last assistant segment', async () => {
    const permissionAnswers: unknown[] = [];
    const fake = fakeAgentIo({
      modes: {
        currentModeId: 'act',
        availableModes: [{ id: 'plan' }, { id: 'act' }],
      },
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'hmm' },
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Let me check.' },
        });
        agent.request(99, 'session/request_permission', {
          sessionId: 's1',
          toolCall: { kind: 'execute' },
          options: [
            { optionId: 'yes', kind: 'allow_once' },
            { optionId: 'no', kind: 'reject_once' },
          ],
        });
      },
      onClientResponse: (id, result, agent) => {
        permissionAnswers.push(result);
        agent.update({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          status: 'pending',
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '{"summary":"ok",' },
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '"findings":[]}' },
        });
        agent.finish();
      },
    });
    const result = await driveAcpSession(
      { input: fake.input, output: fake.output },
      {
        cwd: '/x',
        prompt: 'review it',
        agent: 'fake',
        label: 'review',
        log: noLog,
      },
    );
    assert.equal(result.text, '{"summary":"ok","findings":[]}');
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(fake.setModeIds, ['plan']);
    assert.deepEqual(permissionAnswers, [{ outcome: { outcome: 'selected', optionId: 'yes' } }]);

    // With messageIds, segmentation follows the ids — the last message wins.
    const fake2 = fakeAgentIo({
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: 'first' },
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm2',
          content: { type: 'text', text: 'second ' },
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm2',
          content: { type: 'text', text: 'message' },
        });
        agent.finish();
      },
    });
    const result2 = await driveAcpSession(
      { input: fake2.input, output: fake2.output },
      { cwd: '/x', prompt: 'p', agent: 'fake', label: 'review', log: noLog },
    );
    assert.equal(result2.text, 'second message');
    assert.deepEqual(fake2.setModeIds, []);

    // Model selection rides session/set_config_option when the spec asks for it.
    const fake3 = fakeAgentIo({
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'swe-1-7',
          options: [{ value: 'glm-5-2', name: 'GLM 5.2' }],
        },
      ],
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        });
        agent.finish();
      },
    });
    const result3 = await driveAcpSession(
      { input: fake3.input, output: fake3.output },
      {
        cwd: '/x',
        prompt: 'p',
        agent: 'fake',
        label: 'review',
        log: noLog,
        configOptionModelIds: ['glm-5.2'],
      },
    );
    assert.equal(result3.text, 'ok');
    assert.deepEqual(fake3.setConfigCalls, [
      { sessionId: 's1', configId: 'model', value: 'glm-5-2' },
    ]);

    // kilo shape: no session/modes; plan mode and the model both ride config
    // options, and the model matches on the gateway-prefixed second candidate.
    const fake6 = fakeAgentIo({
      configOptions: [
        {
          id: 'mode',
          category: 'mode',
          currentValue: 'code',
          options: [
            { value: 'code', name: 'Code' },
            { value: 'plan', name: 'Plan' },
          ],
        },
        {
          id: 'model',
          category: 'model',
          currentValue: 'kilo/stealth/paid-model',
          options: [{ value: 'kilo/kilo-auto/free', name: 'Free' }],
        },
      ],
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'kilo-ok' },
        });
        agent.finish();
      },
    });
    const result6 = await driveAcpSession(
      { input: fake6.input, output: fake6.output },
      {
        cwd: '/x',
        prompt: 'p',
        agent: 'kilo',
        label: 'review',
        log: noLog,
        configOptionModelIds: ['kilo/kilo-auto/free', 'kilo-auto/free'],
        requirePlanMode: true,
      },
    );
    assert.equal(result6.text, 'kilo-ok');
    assert.deepEqual(fake6.setConfigCalls, [
      { sessionId: 's1', configId: 'model', value: 'kilo/kilo-auto/free' },
      { sessionId: 's1', configId: 'mode', value: 'plan' },
    ]);

    // Trailing frames after the prompt response are captured (opencode#17505):
    // finish first, then stream text, and the drain must still return it —
    // even though some text arrived before the response.
    const fake4b = fakeAgentIo({
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: '{"summary":"ok",' },
        });
        agent.finish();
        setTimeout(() => {
          agent.update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text: '"findings":[]}' },
          });
        }, 40);
      },
    });
    const result4b = await driveAcpSession(
      { input: fake4b.input, output: fake4b.output },
      { cwd: '/x', prompt: 'p', agent: 'fake', label: 'review', log: noLog },
    );
    assert.equal(result4b.text, '{"summary":"ok","findings":[]}');

    // Auth-gated agents: -32000 on session/new triggers authenticate + one retry.
    const fake5 = fakeAgentIo({
      authMethods: [{ id: 'cli-login', name: 'CLI Login' }],
      authGate: true,
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'authed' },
        });
        agent.finish();
      },
    });
    const result5 = await driveAcpSession(
      { input: fake5.input, output: fake5.output },
      { cwd: '/x', prompt: 'p', agent: 'fake', label: 'review', log: noLog },
    );
    assert.equal(result5.text, 'authed');
    assert.deepEqual(fake5.authCalls, [{ methodId: 'cli-login' }]);

    // requirePlanMode fails closed when the agent offers no plan mode.
    const fake4 = fakeAgentIo({
      modes: { currentModeId: 'code', availableModes: [{ id: 'code' }] },
      onPrompt: (agent) => agent.finish(),
    });
    await assert.rejects(
      driveAcpSession(
        { input: fake4.input, output: fake4.output },
        {
          cwd: '/x',
          prompt: 'p',
          agent: 'fake',
          label: 'review',
          log: noLog,
          requirePlanMode: true,
        },
      ),
      /offered no plan mode/,
    );
  });

  it('materializes the claude, gemini and opencode specs', () => {
    // claude: ambient identity, with the nested-session guard stripped and the
    // API key deliberately kept — it is a way to be the account, not a shadow.
    const seeded = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY'] as const;
    const saved = seeded.map((key) => [key, process.env[key]] as const);
    for (const key of seeded) process.env[key] = `ambient-${key}`;
    try {
      const claude = claudeAcpSpec();
      assert.equal(claude.requirePlanMode, true);
      assert.deepEqual(claude.args('claude/sonnet'), []);
      // Model is a config option with bare-id values; default keeps the
      // member's own configured model rather than selecting one.
      assert.deepEqual(claude.modelConfigCandidates?.('claude/default'), []);
      assert.deepEqual(claude.modelConfigCandidates?.('claude/sonnet'), ['sonnet']);
      const env = claude.env('claude/sonnet').env;
      assert.equal(env.CLAUDECODE, undefined);
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, 'ambient-ANTHROPIC_API_KEY');
      assert.equal(env.HOME, process.env.HOME);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // gemini: temp HOME with only the OAuth material, settings written fresh —
    // the member's own settings.json carries mcpServers a session must not
    // inherit — and ambient provider keys stripped.
    const geminiHome = mkdtempSync(join(tmpdir(), 'symma-test-gemini-'));
    mkdirSync(join(geminiHome, '.gemini'), { recursive: true });
    writeFileSync(geminiOauthPath(geminiHome), '{"access_token":"t"}');
    writeFileSync(join(geminiHome, '.gemini', 'google_accounts.json'), '{}');
    const gemini = geminiAcpSpec(geminiHome);
    assert.deepEqual(gemini.args('gemini/default'), ['--experimental-acp']);
    assert.deepEqual(gemini.args('gemini/gemini-2.5-pro'), [
      '--experimental-acp',
      '-m',
      'gemini-2.5-pro',
    ]);
    // No plan mode exists to satisfy this, so every session refuses — the
    // mechanism keeping DM-tier prose from closing invariant 1 by accident.
    assert.equal(gemini.requirePlanMode, true);
    const savedGemini = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'ambient';
    const geminiLeakPrefix = 'symma-gemini-acp-';
    const geminiEnv = gemini.env('gemini/default');
    try {
      const home = geminiEnv.env.HOME as string;
      // Anchors the leak check below — against a stale prefix both its
      // snapshots are empty and it passes without observing anything.
      assert.ok(home.includes(geminiLeakPrefix));
      assert.notEqual(home, process.env.HOME);
      assert.equal(readFileSync(geminiOauthPath(home), 'utf8'), '{"access_token":"t"}');
      assert.ok(existsSync(join(home, '.gemini', 'google_accounts.json')));
      assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')), {
        selectedAuthType: 'oauth-personal',
      });
      assert.equal(geminiEnv.env.GEMINI_API_KEY, undefined);
      assert.equal(geminiEnv.env.NO_BROWSER, 'true');
    } finally {
      geminiEnv.cleanup?.();
      if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedGemini;
    }
    rmSync(geminiHome, { recursive: true, force: true });
    // A machine with no OAuth material cannot spawn, and the refusal reclaims
    // its temp dir rather than leaking one per attempt.
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith(geminiLeakPrefix));
    const bareHome = mkdtempSync(join(tmpdir(), 'symma-test-gemini-bare-'));
    try {
      assert.throws(() => geminiAcpSpec(bareHome).env('gemini/default'));
    } finally {
      rmSync(bareHome, { recursive: true, force: true });
    }
    assert.deepEqual(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith(geminiLeakPrefix)),
      before,
    );

    // opencode: kilo's lineage — auth materialized into a per-spawn data dir,
    // ambient provider keys stripped, plan required, prefixed model first.
    const opencode = opencodeAcpSpec('{"anthropic":{"type":"oauth"}}');
    assert.equal(opencode.requirePlanMode, true);
    assert.deepEqual(opencode.args('opencode/default'), ['acp']);
    assert.deepEqual(opencode.modelConfigCandidates?.('opencode/default'), []);
    assert.deepEqual(opencode.modelConfigCandidates?.('opencode/claude-sonnet-4-5'), [
      'opencode/claude-sonnet-4-5',
      'claude-sonnet-4-5',
    ]);
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'ambient';
    const opencodeEnv = opencode.env('opencode/default');
    try {
      const dataHome = opencodeEnv.env.XDG_DATA_HOME as string;
      assert.notEqual(opencodeEnv.env.HOME, process.env.HOME);
      assert.equal(
        readFileSync(opencodeAuthPath(dataHome), 'utf8'),
        '{"anthropic":{"type":"oauth"}}',
      );
      assert.equal(opencodeEnv.env.ANTHROPIC_API_KEY, undefined);
    } finally {
      opencodeEnv.cleanup?.();
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it('reattaches to a session the agent still has, and answers fresh when it does not', async () => {
    // `session/load` replays the whole conversation as `session/update`
    // (live-probed against codex-acp 1.1.7), so the previous answer arrives
    // before this turn's prompt is even sent.
    const cases = [
      { label: 'reattaches', loadSession: true, refuse: false, sessionId: 'old-1', loads: 1 },
      { label: 'agent cannot', loadSession: false, refuse: false, sessionId: 's1', loads: 0 },
      { label: 'agent forgot it', loadSession: true, refuse: true, sessionId: 's1', loads: 1 },
      // An auth gate is not a refusal: the session is still there, and losing
      // the reattachment to it would send the turn to a fresh one for nothing.
      {
        label: 'agent wants auth first',
        loadSession: true,
        refuse: false,
        authGate: true,
        sessionId: 'old-1',
        loads: 2,
      },
    ];
    for (const { label, loadSession, refuse, authGate, sessionId, loads } of cases) {
      let loaded = 0;
      const fake = fakeAgentIo({
        capabilities: { loadSession },
        ...(authGate ? { authGate: true, authMethods: [{ id: 'api-key' }] } : {}),
        modes: { currentModeId: 'act', availableModes: [{ id: 'plan' }] },
        onLoad: (agent, authed) => {
          loaded += 1;
          if (refuse) return { error: { code: -32602, message: 'no such session' } };
          if (authGate && !authed) return { error: { code: -32000, message: 'auth required' } };
          agent.update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'item-2',
            content: { type: 'text', text: 'the answer from last time' },
          });
          // Whatever the old session held comes back too, including the asides
          // the adapter put in its message stream.
          agent.update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Warning: from last time.' },
          });
          // What a load actually answers with — the same session state a new
          // one returns, which plan mode and model selection are read off.
          return {
            result: { modes: { currentModeId: 'act', availableModes: [{ id: 'plan' }] } },
          };
        },
        onPrompt: (agent) => {
          agent.update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm9',
            content: { type: 'text', text: 'the answer to this one' },
          });
          agent.finish();
        },
      });
      const result = await driveAcpSession(
        { input: fake.input, output: fake.output },
        {
          cwd: '/tmp',
          prompt: 'hi',
          agent: 'probe',
          label,
          log: () => {},
          resume: 'old-1',
          // Fails closed for agents whose read-only layer is plan mode, so a
          // resume that dropped the loaded session's `modes` would refuse the
          // turn outright.
          requirePlanMode: true,
        },
      );
      assert.equal(loaded, loads, label);
      assert.deepEqual(fake.setModeIds, ['plan'], label);
      assert.deepEqual(result.notices, [], label);
      assert.equal(result.sessionId, sessionId, label);
      // The replay is the turn before this one, so none of it belongs to this
      // one — not as the answer, and not as an aside beside it.
      assert.equal(result.text, 'the answer to this one', label);
    }

    // The caller cannot know whether its resume landed until the load is tried,
    // so it hands over what a fresh session would need either way.
    for (const [label, loadSession, expected] of [
      ['a new session is caught up', false, 'earlier\n\nwhat broke?'],
      ['a resumed one already knows', true, 'what broke?'],
    ] as const) {
      let asked = '';
      const fake = fakeAgentIo({
        capabilities: { loadSession },
        onLoad: () => ({ result: {} }),
        onPrompt: (agent, prompt) => {
          asked = prompt;
          agent.update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text: 'ok' },
          });
          agent.finish();
        },
      });
      await driveAcpSession(
        { input: fake.input, output: fake.output },
        {
          cwd: '/tmp',
          prompt: 'what broke?',
          context: 'earlier',
          resume: 'old-1',
          agent: 'probe',
          label,
          log: () => {},
        },
      );
      assert.equal(asked, expected, label);
    }

    // Still gated after authenticating is the agent refusing credentials, not
    // the session being gone — starting over would need the same ones.
    const gated = fakeAgentIo({
      capabilities: { loadSession: true },
      authMethods: [{ id: 'api-key' }],
      onLoad: () => ({ error: { code: -32000, message: 'auth required' } }),
      onPrompt: (agent) => {
        agent.finish();
      },
    });
    await assert.rejects(
      driveAcpSession(
        { input: gated.input, output: gated.output },
        {
          cwd: '/tmp',
          prompt: 'hi',
          agent: 'probe',
          label: 'gated',
          log: () => {},
          resume: 'old-1',
        },
      ),
    );
  });

  it('keeps what the agent said about itself out of the answer', async () => {
    // codex-acp has no channel for codex's `warning` events, so it puts them in
    // the message stream as text with no `messageId` — live-observed against
    // codex-acp 1.1.7. Agents that label nothing must not be caught by the same
    // rule: for them an absent id is every chunk they send.
    const cases = [
      {
        label: 'labelled',
        chunks: [
          { text: 'Warning: skill descriptions were shortened.' },
          { messageId: 'm1', text: 'the answer' },
        ],
        text: 'the answer',
        notices: ['Warning: skill descriptions were shortened.'],
      },
      {
        label: 'unlabelled',
        chunks: [{ text: 'the ' }, { text: 'answer' }],
        text: 'the answer',
        notices: [],
      },
      {
        // Position decides nothing: an aside after the answer is still an aside.
        // Exempting the last segment was tried and is worse — it cannot be told
        // apart from an agent whose final answer happens to be unlabelled, and
        // guessing that way replaces a real answer with a warning.
        label: 'aside arrives last',
        chunks: [{ messageId: 'm1', text: 'the answer' }, { text: 'Warning: shortened.' }],
        text: 'the answer',
        notices: ['Warning: shortened.'],
      },
      {
        // Nothing labelled survived the filter — here because the labelled
        // chunk carried no text — so the asides are all there is. Returning
        // silence would be the recall hole; showing one as the answer is not.
        label: 'nothing labelled had anything in it',
        chunks: [{ messageId: 'm1', text: '' }, { text: 'the answer' }],
        text: 'the answer',
        notices: [],
      },
      {
        // A notice arriving mid-message splits the message it interrupted. The
        // half before it is then not the last segment, so the answer would come
        // back with its opening missing.
        label: 'notice inside one message',
        chunks: [
          { messageId: 'm1', text: 'the deploy ' },
          { text: 'Warning: shortened.' },
          { messageId: 'm1', text: 'fails on a missing env var' },
        ],
        text: 'the deploy fails on a missing env var',
        notices: ['Warning: shortened.'],
      },
      {
        // A tool call between the two flushes the notice before any labelled
        // chunk exists to say the session labels at all. Classifying then would
        // file it as an answer, where only the last one is ever returned — so
        // it would reach neither `text` nor `notices`.
        label: 'tool call before the first label',
        chunks: [
          { text: 'Warning: shortened.' },
          { tool: true },
          { messageId: 'm1', text: 'the answer' },
        ],
        text: 'the answer',
        notices: ['Warning: shortened.'],
      },
    ];
    for (const { label, chunks, text, notices } of cases) {
      const fake = fakeAgentIo({
        onPrompt: (agent) => {
          for (const chunk of chunks) {
            agent.update(
              chunk.tool
                ? { sessionUpdate: 'tool_call', toolCallId: 't1', status: 'pending' }
                : {
                    sessionUpdate: 'agent_message_chunk',
                    ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
                    content: { type: 'text', text: chunk.text },
                  },
            );
          }
          agent.finish();
        },
      });
      const result = await driveAcpSession(
        { input: fake.input, output: fake.output },
        { cwd: '/tmp', prompt: 'hi', agent: 'probe', label, log: () => {} },
      );
      assert.equal(result.text, text, label);
      assert.deepEqual(result.notices, notices, label);
    }
  });

  it('runs a named workspace from the member own home, mode pinned', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'symma-test-codex-'));
    const runParent = mkdtempSync(join(tmpdir(), 'symma-test-run-'));
    const runHome = join(runParent, 'codex');
    try {
      writeFileSync(codexAuthPath(codexHome), '{"tokens":"t"}');
      const codex = codexAcpSpec(codexHome, runHome);
      assert.equal(codex.modes, true);
      const opened = codex.env('codex/default', { mode: 'agent', workspace: true });
      // The member's own home — their config, MCP servers and history — with
      // nothing of ours written into it, and no run home built on the side.
      assert.equal(opened.env.CODEX_HOME, codexHome);
      assert.ok(!existsSync(join(codexHome, 'config.toml')), 'their home is not ours to configure');
      assert.ok(!existsSync(runHome), 'no run home for a session that does not use it');
      assert.equal(opened.env.INITIAL_AGENT_MODE, 'agent');
      // A roster id folds reasoning effort in; the config takes the pair apart,
      // so the spawn pins both rather than passing codex a model it has no name
      // for. A plain id leaves the member's own effort setting alone.
      assert.equal(
        codex.env('codex/gpt-5.6-sol[high]', { workspace: true }).env.CODEX_CONFIG,
        '{"model":"gpt-5.6-sol","model_reasoning_effort":"high"}',
      );
      assert.equal(
        codex.env('codex/gpt-5.2-codex', { workspace: true }).env.CODEX_CONFIG,
        '{"model":"gpt-5.2-codex"}',
      );
      // A temp-dir open is the isolated path, mode or not: a mode outside a
      // named workspace was refused before the spawn.
      const temp = codex.env('codex/default', { workspace: false });
      assert.equal(temp.env.CODEX_HOME, runHome);
      assert.equal(temp.env.INITIAL_AGENT_MODE, 'read-only');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runParent, { recursive: true, force: true });
    }
  });

  // The codex assertions below are POSIX-shaped — a link to write through, and
  // an inode that a rename changes. Both are what the implementation does
  // everywhere CI runs it (`ubuntu-latest`), and neither holds on the Windows
  // copy path. Gating them would trade a real assertion for a branch nobody
  // executes; adding Windows CI is what would earn the branch.
  it('materializes per-agent read-only and model config', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'symma-test-codex-'));
    writeFileSync(codexAuthPath(codexHome), '{"tokens":"first"}');
    const runParent = mkdtempSync(join(tmpdir(), 'symma-test-run-'));
    // Nested, so the run home is one prepare has to create for itself.
    const runHome = join(runParent, 'codex');
    const codex = codexAcpSpec(codexHome, runHome);
    // Seeded so the strip assertions are not vacuous: env() inherits
    // process.env, so a dropped delete would let the ambient value through.
    const overrides = ['CODEX_CONFIG', 'CODEX_PATH', 'MODEL_PROVIDER'] as const;
    const savedOverrides = overrides.map((key) => [key, process.env[key]] as const);
    for (const key of overrides) process.env[key] = `ambient-${key}`;
    try {
      // Left by a companion killed between staging and the rename. This home
      // outlives the process, so nothing else would ever reclaim it — and on
      // Windows the same shape holds a plaintext credential.
      // Every rule the sweep has to get right, since it deletes and the home is
      // codex's too. Backdating stands in for a companion that died: nothing
      // still being written can be this old.
      mkdirSync(runHome, { recursive: true });
      const aged = (name: string, body: string) => {
        const path = join(runHome, name);
        writeFileSync(path, body);
        utimesSync(path, new Date(0), new Date(0));
        return path;
      };
      const dead = unusedPid(99_999);
      const alsoDead = unusedPid(dead + 1);
      const orphan = aged(`config.toml.${String(dead)}`, 'its companion is gone');
      const alive = aged('config.toml.1', 'old, but its process is still there');
      const notOurs = aged('history.jsonl.4', 'codex wrote this');
      const notStaged = aged('auth.json.backup.123', 'and so did this, despite the shape');
      // Dead too, so age is the only thing keeping it.
      const midWrite = join(runHome, `config.toml.${String(alsoDead)}`);
      writeFileSync(midWrite, "another companion's, seconds old");
      // A staged auth is a symlink, and its target is the member's own file —
      // freshly written above. Aged through the link it would look current
      // forever; `lutimes` backdates the link itself, which is what decides.
      const stagedLink = join(runHome, `auth.json.${String(dead)}`);
      symlinkSync(codexAuthPath(codexHome), stagedLink);
      lutimesSync(stagedLink, new Date(0), new Date(0));

      const codexEnv = codex.env('codex/gpt-5.2-codex');
      assert.equal(codexEnv.env.CODEX_HOME, runHome);
      assert.ok(!existsSync(orphan), 'a staging file whose process is gone is reclaimed');
      assert.ok(existsSync(alive), 'one whose pid still answers is not');
      assert.ok(existsSync(midWrite), 'nor is one too new to have been abandoned');
      assert.ok(existsSync(notOurs), 'a name symma never stages is not ours to delete');
      assert.ok(existsSync(notStaged), 'and neither is one that only looks like a stage');
      assert.ok(!existsSync(stagedLink), 'a stranded auth link is aged by itself, not its target');

      // The model is deliberately NOT here: sessions share this file, so a
      // per-spawn write is one run reading another's config.
      assert.equal(
        readFileSync(join(runHome, 'config.toml'), 'utf8'),
        'sandbox_mode = "read-only"\n',
      );
      assert.equal(codexEnv.env.CODEX_CONFIG, '{"model":"gpt-5.2-codex"}');

      // Written through the link and read back from the original: asserting
      // the link's own contents would pass just as well on a copy, and a copy
      // is what strands codex's in-place token refresh.
      writeFileSync(codexAuthPath(runHome), '{"tokens":"refreshed"}');
      assert.equal(readFileSync(codexAuthPath(codexHome), 'utf8'), '{"tokens":"refreshed"}');

      // No cleanup to call is the point: a home that went with the run is a
      // rollout nothing can load back.
      assert.equal(codexEnv.cleanup, undefined);
      writeFileSync(join(runHome, 'sessions.probe'), 'a rollout would live here');
      // A rename swaps the inode, so an unchanged one is the proof that the
      // steady state writes nothing — which is what keeps a concurrent spawn
      // from ever reading this file half-written.
      const settled = statSync(join(runHome, 'config.toml')).ino;
      const second = codex.env('codex/default');
      assert.equal(statSync(join(runHome, 'config.toml')).ino, settled);
      assert.ok(existsSync(join(runHome, 'sessions.probe')), 'a second spawn reuses the home');
      // `default` names no model, so the ambient override must not stand in.
      assert.equal(second.env.CODEX_CONFIG, undefined);

      assert.equal(codexEnv.env.CODEX_PATH, undefined);
      assert.equal(codexEnv.env.MODEL_PROVIDER, undefined);
      assert.equal(codexEnv.env.INITIAL_AGENT_MODE, 'read-only');
      assert.equal(codexEnv.env.NO_BROWSER, '1');
      // A real copy an older build left here is migrated, not kept as the stale
      // credential it has become.
      rmSync(codexAuthPath(runHome), { force: true });
      writeFileSync(codexAuthPath(runHome), '{"tokens":"stale copy"}');
      codex.env('codex/default');
      // Content alone would pass on a copy of the right bytes. What migration
      // is for is giving the refresh somewhere to land again.
      assert.ok(lstatSync(codexAuthPath(runHome)).isSymbolicLink());
      writeFileSync(codexAuthPath(runHome), '{"tokens":"after migration"}');
      assert.equal(readFileSync(codexAuthPath(codexHome), 'utf8'), '{"tokens":"after migration"}');

      // And so is a link left pointing at some other home, which is a
      // credential that either fails or belongs to somebody else.
      rmSync(codexAuthPath(runHome), { force: true });
      symlinkSync(join(codexHome, 'someone-else.json'), codexAuthPath(runHome));
      codex.env('codex/default');
      assert.equal(readlinkSync(codexAuthPath(runHome)), codexAuthPath(codexHome));
    } finally {
      for (const [key, value] of savedOverrides) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runParent, { recursive: true, force: true });
    }

    const codexEmptyHome = mkdtempSync(join(tmpdir(), 'symma-test-empty-'));
    const emptyRun = join(codexEmptyHome, 'run');
    try {
      assert.throws(() => codexAcpSpec(codexEmptyHome, emptyRun).env('codex/default'));
      assert.ok(!existsSync(emptyRun), 'and nothing is built for a home that has none');
    } finally {
      rmSync(codexEmptyHome, { recursive: true, force: true });
    }

    const kilo = kiloAcpSpec('{"token":"k"}');
    assert.deepEqual(kilo.args('kilo/default'), ['acp']);
    assert.equal(kilo.requirePlanMode, true);
    // Selection ALWAYS runs: kilo's session default is a paid model while
    // a caller's `kilo/default` means the free gateway tier; values are prefixed.
    assert.deepEqual(kilo.modelConfigCandidates?.('kilo/default'), [
      'kilo/kilo-auto/free',
      'kilo-auto/free',
    ]);
    assert.deepEqual(kilo.modelConfigCandidates?.('kilo/stepfun/step-3.7-flash:free'), [
      'kilo/stepfun/step-3.7-flash:free',
      'stepfun/step-3.7-flash:free',
    ]);
    const kiloEnv = kilo.env('kilo/default');
    try {
      assert.equal(kiloEnv.env.KILO_AUTH_CONTENT, '{"token":"k"}');
      assert.notEqual(kiloEnv.env.HOME, process.env.HOME);
    } finally {
      kiloEnv.cleanup?.();
    }
    assert.throws(() => kiloAcpSpec('not json').env('kilo/default'));

    assert.deepEqual(cursorAcpSpec('key').args('cursor/composer-2'), [
      '--model',
      'composer-2',
      'acp',
    ]);
    assert.deepEqual(cursorAcpSpec('key').args('cursor/default'), ['acp']);
    const devinHome = mkdtempSync(join(tmpdir(), 'symma-test-devin-'));
    const sourceCredentials = devinCredentialsPath(devinHome);
    mkdirSync(dirname(sourceCredentials), { recursive: true });
    writeFileSync(sourceCredentials, 'windsurf_api_key = "k"\n');
    const devin = devinAcpSpec(devinHome);
    assert.deepEqual(devin.args('devin/glm-5.2'), ['acp']);
    assert.deepEqual(devin.modelConfigCandidates?.('devin/glm-5.2'), ['glm-5.2', 'devin/glm-5.2']);
    assert.deepEqual(devin.modelConfigCandidates?.('devin/default'), []);
    assert.equal(devin.requirePlanMode, true);
    const devinLeakPrefix = 'symma-devin-acp-';
    const devinEnv = devin.env('devin/glm-5.2');
    try {
      const home = devinEnv.env.HOME as string;
      assert.notEqual(home, devinHome);
      assert.ok(home.includes(devinLeakPrefix), 'devin temp dirs carry the expected prefix');
      assert.equal(devinEnv.env.XDG_CONFIG_HOME, undefined);
      assert.ok(existsSync(devinCredentialsPath(home)));
      const config = JSON.parse(
        readFileSync(join(home, '.config', 'devin', 'config.json'), 'utf8'),
      ) as { permissions: { deny: string[] } };
      assert.ok(config.permissions.deny.includes('write'));
    } finally {
      devinEnv.cleanup?.();
    }
    // I/O failure after mkdtemp must reclaim the temp dir (no cleanup returned).
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith(devinLeakPrefix));
    const devinEmptyHome = mkdtempSync(join(tmpdir(), 'symma-test-empty-'));
    try {
      assert.throws(() => devinAcpSpec(devinEmptyHome).env('devin/default'));
    } finally {
      rmSync(devinEmptyHome, { recursive: true, force: true });
    }
    const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith(devinLeakPrefix));
    assert.deepEqual(after, before);
    rmSync(devinHome, { recursive: true, force: true });

    const modelOptions = [
      { value: 'glm-5-2', name: 'GLM 5.2' },
      { value: 'claude-opus-4-8-medium', name: 'Claude Opus 4.8 Medium' },
    ];
    assert.equal(matchModelOptionValue(modelOptions, 'glm-5-2'), 'glm-5-2');
    assert.equal(matchModelOptionValue(modelOptions, 'glm-5.2'), 'glm-5-2');
    assert.equal(
      matchModelOptionValue(modelOptions, 'claude opus 4.8 medium'),
      'claude-opus-4-8-medium',
    );
    assert.equal(matchModelOptionValue(modelOptions, 'nope'), undefined);
    // Grouped option lists flatten; a group header's name is never a model.
    const grouped = [
      { name: 'Recommended', options: [{ value: 'glm-5-2', name: 'GLM 5.2' }] },
      { name: 'Other', options: [{ value: 'swe-1-7', name: 'SWE 1.7' }] },
    ];
    assert.equal(matchModelOptionValue(grouped, 'glm-5.2'), 'glm-5-2');
    assert.equal(matchModelOptionValue(grouped, 'swe-1-7'), 'swe-1-7');
    assert.equal(matchModelOptionValue(grouped, 'recommended'), undefined);
  });
});
