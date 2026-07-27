/**
 * The observer wire envelope and its parser. Lives in the protocol package
 * rather than the journal that stores it: the companion signs and sends these,
 * the client tees them, and the gateway stores them — a shape with three
 * consumers belongs to none of them.
 */
import { isSafeId } from './ids.ts';

/**
 * One observed ACP frame, as sent by the jbot-side tee (or the demo feeder).
 * `dir` is the frame's direction on the original stdio pair: `out` =
 * client→agent, `in` = agent→client. The gateway treats `frame` opaquely —
 * rendering is the viewer's job, so protocol evolution never breaks ingest.
 */
export interface ObserverEnvelope {
  v: 1;
  runId: string;
  sessionId: string;
  seq: number;
  ts: number;
  agent: string;
  label: string;
  dir: 'out' | 'in';
  frame: Record<string, unknown>;
  /** jbot model string for this session (`<provider>/<id>`), for viewer meta. */
  model?: string;
  /** Signing endpoint, so a reader knows which advertised key to verify against. */
  endpoint?: string;
}

/** Validates an ingest line just enough to store and replay it faithfully. */
export function parseEnvelope(line: string): ObserverEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const e = value as Record<string, unknown>;
  if (e.v !== 1) return undefined;
  if (!isSafeId(e.runId) || !isSafeId(e.sessionId)) return undefined;
  if (typeof e.seq !== 'number' || typeof e.ts !== 'number') return undefined;
  if (typeof e.agent !== 'string' || typeof e.label !== 'string') return undefined;
  if (e.dir !== 'out' && e.dir !== 'in') return undefined;
  if (typeof e.frame !== 'object' || e.frame === null) return undefined;
  return e as unknown as ObserverEnvelope;
}
