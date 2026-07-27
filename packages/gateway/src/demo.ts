/**
 * Feeds a scripted-but-realistic review session into a running gateway so the
 * viewer can be exercised with zero credentials and zero model spend:
 *
 *   npm run gateway         # terminal 1
 *   npm run gateway:demo    # terminal 2, then open http://127.0.0.1:8790
 *
 * Frame shapes mirror real ACP traffic (kilo/devin captures), so the viewer
 * is tested against what production actually emits.
 */
import type { ObserverEnvelope } from '@symma/protocol';

const url = process.env.JBOT_GATEWAY_URL?.trim() || 'http://127.0.0.1:8790';
const token = process.env.JBOT_GATEWAY_TOKEN?.trim() || '';

const runId = `demo-${new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19)}`;

interface Step {
  delayMs: number;
  sessionId: string;
  label: string;
  dir: 'out' | 'in';
  frame: Record<string, unknown>;
}

const update = (update: Record<string, unknown>): Record<string, unknown> => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 's1', update },
});
const say = (text: string): Record<string, unknown> =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const think = (text: string): Record<string, unknown> =>
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });

function reviewSession(sessionId: string, label: string, finding: string): Step[] {
  const s = (dir: 'out' | 'in', frame: Record<string, unknown>, delayMs = 120): Step => ({
    delayMs,
    sessionId,
    label,
    dir,
    frame,
  });
  return [
    s('out', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }, 200),
    s('in', { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    s('out', { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/workspace' } }),
    s('in', { jsonrpc: '2.0', id: 2, result: { sessionId: 's1' } }),
    s('out', {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_config_option',
      params: { sessionId: 's1', configId: 'model', value: 'kilo/kilo-auto/free' },
    }),
    s('in', { jsonrpc: '2.0', id: 3, result: { configOptions: [] } }),
    s('out', { jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: 's1' } }, 300),
    s('in', think('Reading the diff hunks and the review guidelines'), 500),
    s('in', think(' before checking the changed call sites…'), 400),
    s('in', update({ sessionUpdate: 'tool_call', title: 'git diff --stat', kind: 'execute' }), 600),
    s('in', {
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        toolCall: { kind: 'execute', title: 'git grep -n handlePrEvent' },
        options: [{ optionId: 'allow', kind: 'allow_once' }],
      },
    }),
    s(
      'out',
      { jsonrpc: '2.0', id: 9, result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
      350,
    ),
    s(
      'in',
      update({ sessionUpdate: 'tool_call', title: 'git grep -n handlePrEvent', kind: 'execute' }),
      250,
    ),
    s('in', think('The guard clause moved but one caller still passes the old shape.'), 700),
    s('in', say('{"summary":"One correctness issue in the moved guard clause.",'), 500),
    s('in', say(`"findings":[${finding}],`), 300),
    s('in', say('"addressedPriorComments":[]}'), 250),
    s('in', update({ sessionUpdate: 'usage_update', used: 48211, size: 256000 }), 200),
    s('in', { jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } }, 150),
  ];
}

const finding =
  '{"file":"src/shared/runner.ts","line":42,"severity":"P2","title":"Stale caller misses the new guard"}';

// Alternate small blocks so the two sessions stream the way a real parallel
// run does, instead of playing back-to-back.
function interleave(a: Step[], b: Step[]): Step[] {
  const out: Step[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 3) {
    out.push(...a.slice(i, i + 3), ...b.slice(i, i + 3));
  }
  return out;
}

const steps = interleave(
  reviewSession('review', 'review', finding),
  reviewSession('guideline-compliance', 'guideline-compliance', ''),
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const seqBySession = new Map<string, number>();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Announce in-progress up front, like a real review's runPrReview does.
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({ v: 1, kind: 'run', runId, status: 'reviewing', ts: Date.now() })}\n`,
        ),
      );
      for (const step of steps) {
        await sleep(step.delayMs);
        const seq = (seqBySession.get(step.sessionId) ?? 0) + 1;
        seqBySession.set(step.sessionId, seq);
        const envelope: ObserverEnvelope = {
          v: 1,
          runId,
          sessionId: step.sessionId,
          seq,
          ts: Date.now(),
          agent: 'kilo',
          label: step.label,
          model: 'kilo/kilo-auto/free',
          dir: step.dir,
          frame: step.frame,
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(envelope)}\n`));
      }
      // Mark the run completed, like a real review's verdict does.
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({ v: 1, kind: 'run', runId, status: 'completed', ts: Date.now() })}\n`,
        ),
      );
      controller.close();
    },
  });
  console.log(`[gateway-demo] streaming run ${runId} to ${url} — open the viewer to watch live`);
  const response = await fetch(`${url}/api/ingest`, {
    method: 'POST',
    body,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    // Node fetch requires half-duplex to be explicit for streamed bodies.
    duplex: 'half',
  } as RequestInit);
  console.log(`[gateway-demo] ingest replied ${response.status}: ${await response.text()}`);
}

await main();
