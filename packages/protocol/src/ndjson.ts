import type { IncomingMessage } from 'node:http';

// Ingest caps: one NDJSON line, and one whole request body. Both fail closed
// so an oversized or never-terminated line can't OOM the gateway. The
// per-line cap sits above the ACP frame budget (32MB) so a legitimate large
// frame passes; it only stops a line that never terminates.
const MAX_LINE_BYTES = 48 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024 * 1024;

/**
 * Streams a request body as NDJSON lines with byte-exact caps. Newlines are
 * searched per-chunk (never a whole-buffer rescan), so an unterminated line
 * stays O(total). Returns overflow=true when a cap was hit; the caller
 * responds 413 and destroys the request.
 */
export async function readNdjsonBody(
  req: IncomingMessage,
  onLine: (line: string) => void,
): Promise<{ overflow: boolean }> {
  let total = 0;
  let partial = '';
  let partialBytes = 0;
  let overflow = false;
  const take = (line: string, extraBytes: number): void => {
    if (partialBytes + extraBytes > MAX_LINE_BYTES) overflow = true;
    else if (line.trim()) onLine(line);
    partial = '';
    partialBytes = 0;
  };
  req.setEncoding('utf8');
  for await (const chunk of req as AsyncIterable<string>) {
    total += Buffer.byteLength(chunk);
    if (total > MAX_BODY_BYTES) return { overflow: true };
    let start = chunk.indexOf('\n');
    if (start === -1) {
      partial += chunk;
      partialBytes += Buffer.byteLength(chunk);
      if (partialBytes > MAX_LINE_BYTES) return { overflow: true };
      continue;
    }
    // Each completed line is length-checked (partial carry-over + this chunk's
    // slice), so a cap-exceeding line can't slip through by ending in-chunk.
    const head = chunk.slice(0, start);
    take(partial + head, Buffer.byteLength(head));
    if (overflow) return { overflow: true };
    let nl = chunk.indexOf('\n', start + 1);
    while (nl !== -1) {
      const line = chunk.slice(start + 1, nl);
      take(line, Buffer.byteLength(line));
      if (overflow) return { overflow: true };
      start = nl;
      nl = chunk.indexOf('\n', start + 1);
    }
    partial = chunk.slice(start + 1);
    partialBytes = Buffer.byteLength(partial);
    if (partialBytes > MAX_LINE_BYTES) return { overflow: true };
  }
  take(partial, 0);
  return { overflow };
}
