/**
 * Slack files, fetched so the agent can actually read them (§10 amended: v1
 * named them and never fetched, which is why an agent asked about a CSV could
 * only report that one existed).
 *
 * Its own module because two decisions live here and neither belongs in a
 * handler: which files are worth sending at all, and what the download is
 * allowed to cost. Both are policy the bot owns — the protocol only asks
 * whether the agent advertised the block a file would need.
 */
import type { PromptAttachment } from '@symma/protocol';

/** What Slack says about one file on a message. `url_private_download` needs
 * the bot token as a bearer header; it is not a public link. */
export interface SlackFile {
  name?: unknown;
  mimetype?: unknown;
  filetype?: unknown;
  size?: unknown;
  url_private_download?: unknown;
}

/** What a download hands back. Named because three layers pass it along, and
 * an inline shape repeated three times drifts on the first change. */
export interface FetchedFile {
  ok: boolean;
  bytes?: Buffer;
  status?: number;
}

/** Per-file ceiling. A spreadsheet dumped into a channel is routinely megabytes
 * of base64 that would crowd out the question itself, and the member gets told
 * which files were skipped either way. */
const MAX_FILE_BYTES = 512 * 1024;
/** Total across one turn, so five files cannot each pass the per-file bar and
 * together bury the prompt. */
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_FILES = 5;

/** Text this agent can read as-is. Deliberately extension-and-mime based rather
 * than sniffed: a wrong guess here sends binary as text, which is worse than
 * skipping the file and saying so. */
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
/** Images ACP's image block takes; anything else Slack calls an image is not
 * something a model is promised to decode. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** What one file turned into, or why it did not. The refusal is a sentence for
 * the member: a file silently absent is the failure this module exists to fix. */
export type Attached =
  { ok: true; file: PromptAttachment } | { ok: false; name: string; why: string };

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value ? value : fallback;

/** How a file should travel, by what Slack claims it is. */
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
 * Fetches what the agent can use and says what it skipped. Never throws: a file
 * that will not download must cost its own line in the answer's asides, not the
 * turn — the question is usually answerable without it.
 */
export async function collectAttachments(
  files: SlackFile[],
  fetchFile: (url: string) => Promise<FetchedFile>,
): Promise<Attached[]> {
  const out: Attached[] = [];
  let spent = 0;
  for (const file of files) {
    const name = str(file.name, 'file');
    if (out.filter((entry) => entry.ok).length >= MAX_FILES) {
      out.push({ ok: false, name, why: `only the first ${String(MAX_FILES)} files were read` });
      continue;
    }
    const kind = classify(file);
    if (!kind) {
      out.push({
        ok: false,
        name,
        why: `${str(file.filetype, 'that type')} is not something I can pass along`,
      });
      continue;
    }
    // Checked before the download, not after: the point of a ceiling is to not
    // pull the bytes.
    const size = typeof file.size === 'number' ? file.size : 0;
    if (size > MAX_FILE_BYTES) {
      out.push({ ok: false, name, why: `too big to send (${String(Math.round(size / 1024))}kB)` });
      continue;
    }
    const url = str(file.url_private_download);
    if (!url) {
      out.push({ ok: false, name, why: 'Slack gave me no way to download it' });
      continue;
    }
    const got = await fetchFile(url).catch((): FetchedFile => ({ ok: false }));
    if (!got.ok || !got.bytes) {
      out.push({
        ok: false,
        name,
        why: got.status === 403 ? 'I am not allowed to read it' : 'it would not download',
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
    ? [`Could not read ${skipped.map((s) => `${s.name} (${s.why})`).join(', ')}.`]
    : [];
}
