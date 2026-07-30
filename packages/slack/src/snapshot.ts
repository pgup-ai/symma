/**
 * The context a mention carries into its conversation (§4). Pure: the budget
 * arithmetic and the omission accounting are what is worth testing, and neither
 * needs Slack.
 */

export interface ThreadMessage {
  ts: string;
  author: string;
  text: string;
  /** Names and sizes only. v1 never fetches contents: downloading files widens
   * both the scope request and the data-lifecycle surface (§10). */
  files?: { name: string; size?: number }[];
}

export interface Snapshot {
  text: string;
  /** The newest ts included, which becomes the conversation's cursor. Absent
   * when there was nothing to include. */
  seenThroughTs?: string;
  omitted: number;
}

const render = (message: ThreadMessage): string => {
  const files = message.files?.map((f) => f.name).join(', ');
  return `[${message.ts}] ${message.author}: ${message.text}${files ? `\n  files: ${files}` : ''}`;
};

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

const noteFor = (n: number): string =>
  `… ${n} earlier ${n === 1 ? 'reply' : 'replies'} omitted to fit the budget …`;

const MARKER = ' … [truncated]';

/**
 * Cut to fit, saying so — a must-keep message that blew the ceiling used to be
 * exempted from it, which put a snapshot past what Slack will accept.
 *
 * Undefined when the budget cannot hold the marker and a character of the line.
 * Returning a bare marker would exceed the budget it was handed, and a caller
 * keeping an empty line would advance the cursor over a message the member never
 * saw a word of.
 */
const fit = (line: string, budget: number): string | undefined => {
  if (bytes(line) <= budget) return line;
  const room = budget - bytes(MARKER);
  if (room < 1) return undefined;
  let cut = line;
  while (bytes(cut) > room) cut = cut.slice(0, -Math.max(1, Math.ceil((bytes(cut) - room) / 4)));
  return cut + MARKER;
};

/**
 * `since` makes this a delta: a repeat mention pulls what the agent has not been
 * shown rather than the thread again, which is what stops later messages
 * reaching a turn nobody asked to include them in.
 *
 * Over budget, the root survives and the newest replies fill the rest — the two
 * ends a reader needs — and the count of what went missing is stated in the text
 * rather than left for the member to notice.
 */
export function threadSnapshot(
  messages: ThreadMessage[],
  options: { budgetBytes: number; since?: string },
): Snapshot {
  // Sorted before filtering, so a delta cannot depend on the caller having
  // ordered its pages. Slack ts values are fixed-width decimal strings, which is
  // why they order lexically.
  const ordered = [...messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const since = options.since;
  const candidates = since ? ordered.filter((m) => m.ts > since) : ordered;
  if (candidates.length === 0) return { text: '', omitted: 0 };

  // A delta has no root among its candidates — the agent was already shown it.
  const root = since ? undefined : candidates[0];
  const rest = root ? candidates.slice(1) : candidates;

  // Reserved before anything is measured against it. The note is part of the
  // snapshot, so composing it afterwards put it outside the very ceiling it
  // describes. Sized for the worst case — everything omitted — which is the most
  // digits the count can have, so the real note always fits the room kept.
  const wanted = rest.length > 0 ? bytes(noteFor(rest.length)) + 1 : 0;
  // Only reserved when it can be afforded. Below a budget that holds the note
  // itself there is no room to explain an omission, and printing it regardless
  // would break the ceiling in the course of describing it.
  const reserve = wanted <= options.budgetBytes ? wanted : 0;
  const budget = options.budgetBytes - reserve;

  // The root counts against the ceiling like anything else; it used to be
  // included unmeasured.
  // Unshowable and it is not kept either, so nothing claims it was read.
  const rootLine = root ? fit(render(root), budget) : undefined;
  const shownRoot = rootLine === undefined ? undefined : root;
  let used = bytes(rootLine ?? '');
  const tail: { message: ThreadMessage; line: string }[] = [];
  for (const [i, message] of [...rest].reverse().entries()) {
    // The newest reply is kept where the rest are dropped, because dropping it
    // would either lose what the member just pointed at or advance the cursor
    // over it. Trimmed to the ceiling rather than exempted from it, less the
    // newline it is joined with — and left out entirely if not even a trimmed
    // form fits, so the cursor does not move over it either.
    const line = i === 0 ? fit(render(message), budget - used - 1) : render(message);
    if (line === undefined) break;
    const cost = bytes(line) + 1;
    if (i > 0 && used + cost > budget) break;
    used += cost;
    tail.unshift({ message, line });
  }

  const omitted = rest.length - tail.length;
  // No assertion on the tail: an earlier draft read the last element of an empty
  // array and crashed. Absent is also the safe answer — a cursor that does not
  // move is a turn re-read, where one that moves too far is work never seen.
  const newest = tail.at(-1)?.message ?? shownRoot;
  const note = omitted && reserve > 0 ? [noteFor(omitted)] : [];
  // The note sits where the messages were dropped from, so the gap is visible in
  // place rather than as a footnote about the thread as a whole.
  const shown = tail.map((t) => t.line);
  const lines = rootLine === undefined ? [...note, ...shown] : [rootLine, ...note, ...shown];
  return { text: lines.join('\n'), ...(newest ? { seenThroughTs: newest.ts } : {}), omitted };
}
