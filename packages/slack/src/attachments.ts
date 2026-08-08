/**
 * Slack files, fetched so the agent can read them — v1 named them and never
 * fetched, which is why an agent asked about a CSV could only confirm one
 * existed (§10).
 *
 * Its own module because the two decisions here are the bot's policy and not a
 * handler's: which files are worth sending, and what the download may cost. The
 * protocol only asks whether the agent advertised the block a file needs.
 */
import type { PromptAttachment } from '@symma/protocol';

import { plainly } from './slack-api.js';

/** `url_private_download` needs the bot token as a bearer header; it is not a
 * public link. */
export interface SlackFile {
  name?: unknown;
  mimetype?: unknown;
  filetype?: unknown;
  size?: unknown;
  url_private_download?: unknown;
}

export interface FetchedFile {
  ok: boolean;
  bytes?: Buffer;
  status?: number;
}

const MAX_FILE_BYTES = 512 * 1024;
/** So five files that each clear the per-file bar cannot together bury the
 * question they came with. */
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_FILES = 5;

/** Matched on mime and Slack's own type name rather than sniffed: guessing
 * wrong sends a binary as text, which is worse than skipping it and saying so. */
const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/xml',
  'text/xml',
  'text/html',
  'application/x-yaml',
  'text/yaml',
]);
const TEXT_FILETYPES = new Set([
  'text',
  'markdown',
  'md',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'log',
  'diff',
  'patch',
  'javascript',
  'typescript',
  'python',
  'go',
  'rust',
  'java',
  'ruby',
  'php',
  'sql',
  'sh',
  'shell',
]);
/** What ACP's image block promises a model can decode; not everything Slack
 * files under "image". */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A refusal carries a sentence for the member — a file silently absent from an
 * answer is the failure this module exists to fix. */
export type Attached =
  { ok: true; file: PromptAttachment } | { ok: false; name: string; why: string };

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value ? value : fallback;

/** What a download's own status is worth saying to a member. Anything else is
 * a transport problem they can only retry. */
const DOWNLOAD_REFUSALS: Record<number, string> = {
  403: 'I am not allowed to read it',
  // The CDN served more than Slack said it would.
  413: 'it turned out too big to send',
};

function classify(file: SlackFile): 'text' | 'image' | undefined {
  const mime = str(file.mimetype).toLowerCase().split(';')[0]!;
  const kind = str(file.filetype).toLowerCase();
  if (IMAGE_TYPES.has(mime)) return 'image';
  if (TEXT_TYPES.has(mime) || TEXT_FILETYPES.has(kind)) return 'text';
  // Slack labels plenty of source files `text/plain` already; this catches the
  // rest by its own type name without opening the door to binaries.
  return mime.startsWith('text/') ? 'text' : undefined;
}

/**
 * Never throws: a file that will not download costs its own line in the asides,
 * not the turn — the question is usually answerable without it.
 */
export async function collectAttachments(
  files: SlackFile[],
  fetchFile: (url: string, maxBytes: number) => Promise<FetchedFile>,
): Promise<Attached[]> {
  const out: Attached[] = [];
  let spent = 0;
  for (const file of files) {
    const name = str(file.name, 'file');
    // Examined, not succeeded: counting only the successes would let fifty
    // attached files each cost a classify and a download.
    if (out.length >= MAX_FILES) {
      out.push({ ok: false, name, why: `only the first ${String(MAX_FILES)} files were read` });
      continue;
    }
    const kind = classify(file);
    if (!kind) {
      out.push({
        ok: false,
        name,
        // Slack's own word for the type, riding the same mrkdwn aside the name
        // does.
        why: `${plainly(str(file.filetype, 'that type')) || 'that type'} is not something I can pass along`,
      });
      continue;
    }
    // Before the download, not after: the point of a ceiling is to not pull the
    // bytes. An unreported size is refused rather than read as zero — the
    // fetch below caps what Slack under-reports, but a file nobody sized is
    // one nothing bounded.
    const size = typeof file.size === 'number' && file.size >= 0 ? file.size : undefined;
    if (size === undefined) {
      out.push({ ok: false, name, why: 'Slack did not say how big it is' });
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      out.push({ ok: false, name, why: `too big to send (${String(Math.round(size / 1024))}kB)` });
      continue;
    }
    const url = str(file.url_private_download);
    if (!url) {
      out.push({ ok: false, name, why: 'Slack gave me no way to download it' });
      continue;
    }
    const got = await fetchFile(url, MAX_FILE_BYTES).catch((): FetchedFile => ({ ok: false }));
    if (!got.ok || !got.bytes) {
      out.push({
        ok: false,
        name,
        why: DOWNLOAD_REFUSALS[got.status ?? 0] ?? 'it would not download',
      });
      continue;
    }
    if (spent + got.bytes.byteLength > MAX_TOTAL_BYTES) {
      out.push({ ok: false, name, why: 'the files together were more than one turn can carry' });
      continue;
    }
    spent += got.bytes.byteLength;
    out.push({
      ok: true,
      file: {
        name,
        mimeType: str(file.mimetype, kind === 'image' ? 'image/png' : 'text/plain'),
        kind,
        data: kind === 'image' ? got.bytes.toString('base64') : got.bytes.toString('utf8'),
      },
    });
  }
  return out;
}

/** One aside naming what did not make it, or nothing. Grouped into a single
 * line: five skipped files should not push the agent's own notices out of the
 * message. */
export function skippedNote(attached: Attached[]): string[] {
  const skipped = attached.filter((entry) => !entry.ok);
  return skipped.length
    ? [`Could not read ${skipped.map((s) => `${plainly(s.name)} (${s.why})`).join(', ')}.`]
    : [];
}
