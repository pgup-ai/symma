import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { join } from 'node:path';

import { isSafeId, type ObserverEnvelope } from '@symma/protocol';

export type RunStatus = 'reviewing' | 'completed' | 'failed';
const RUN_STATUSES: RunStatus[] = ['reviewing', 'completed', 'failed'];

/** Run-level lifecycle control (the caller's verdict), sent on the ingest
 * stream alongside frames but stored per-run, not per-session. */
export interface RunControl {
  v: 1;
  kind: 'run';
  runId: string;
  status: RunStatus;
  ts: number;
}

export function journalPath(dataDir: string, runId: string, sessionId: string): string {
  return join(dataDir, runId, `${sessionId}.ndjson`);
}

/** Parse a run-status control line (distinct from a frame envelope). */
export function parseRunControl(line: string): RunControl | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || c.kind !== 'run' || !isSafeId(c.runId)) return undefined;
  if (!RUN_STATUSES.includes(c.status as RunStatus) || typeof c.ts !== 'number') return undefined;
  return c as unknown as RunControl;
}

// Journals hold prompt/diff content, so keep them off other host accounts:
// 0700 dirs, 0600 files. A per-run mkdir cache avoids a syscall per frame.
const ensuredDirs = new Set<string>();
function ensureRunDir(dataDir: string, runId: string): string {
  const dir = join(dataDir, runId);
  if (!ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensuredDirs.add(dir);
  }
  return dir;
}

export function writeRunStatus(dataDir: string, control: RunControl): void {
  const dir = ensureRunDir(dataDir, control.runId);
  writeFileSync(join(dir, 'status'), control.status, { mode: 0o600 });
}

export function readRunStatus(dataDir: string, runId: string): RunStatus | undefined {
  const path = join(dataDir, runId, 'status');
  if (!existsSync(path)) return undefined;
  let value: string;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    return undefined; // permission/disk error: treat as no status, never throw
  }
  return RUN_STATUSES.includes(value as RunStatus) ? (value as RunStatus) : undefined;
}

export function appendEnvelope(dataDir: string, envelope: ObserverEnvelope): void {
  ensureRunDir(dataDir, envelope.runId);
  appendFileSync(
    journalPath(dataDir, envelope.runId, envelope.sessionId),
    `${JSON.stringify(envelope)}\n`,
    { mode: 0o600 },
  );
}

export interface RunSummary {
  runId: string;
  sessions: string[];
  updatedAt: number;
  status?: RunStatus;
}

/** Remove one session's frames. The row is deleted separately; a missing file
 * is the expected case when a session never produced any. */
export function deleteJournal(dataDir: string, runId: string, sessionId: string): void {
  rmSync(journalPath(dataDir, runId, sessionId), { force: true });
}

/** Newest-first run listing from the plain directory layout — no index, no DB.
 * fs errors on any single run are skipped, never thrown, so one bad directory
 * can't take down the listing (or the gateway). */
export function listRuns(dataDir: string): RunSummary[] {
  if (!existsSync(dataDir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: RunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
    const runDir = join(dataDir, entry.name);
    const sessions: string[] = [];
    let updatedAt = 0;
    try {
      for (const file of readdirSync(runDir)) {
        if (!file.endsWith('.ndjson')) continue;
        const sessionId = file.slice(0, -'.ndjson'.length);
        if (!isSafeId(sessionId)) continue;
        sessions.push(sessionId);
        updatedAt = Math.max(updatedAt, statSync(join(runDir, file)).mtimeMs);
      }
    } catch {
      continue; // unreadable run dir: skip it, keep listing the rest
    }
    const status = readRunStatus(dataDir, entry.name);
    // A run that failed before any ACP session still has a status file and
    // must stay discoverable, so list it even with no session journals.
    if (status) {
      try {
        updatedAt = Math.max(updatedAt, statSync(join(runDir, 'status')).mtimeMs);
      } catch {
        /* status vanished mid-list: keep the run, mtime stays 0 */
      }
    }
    if (sessions.length > 0 || status) {
      runs.push({
        runId: entry.name,
        sessions: sessions.sort(),
        updatedAt,
        ...(status ? { status } : {}),
      });
    }
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Journal replay as raw NDJSON lines (already-validated envelopes). */
export function readJournalLines(dataDir: string, runId: string, sessionId: string): string[] {
  const path = journalPath(dataDir, runId, sessionId);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return []; // corrupt/unreadable journal: empty replay, never throw
  }
}
