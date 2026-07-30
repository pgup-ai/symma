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

/** Cut to fit, saying so. A must-keep message that blew the ceiling used to be
 * exempted from it, which could put a snapshot past what Slack will accept — so
 * the budget stopped being a budget at the one moment it mattered. */
const fit = (line: string, budget: number): string => {
  if (bytes(line) <= budget) return line;
  const marker = ' … [truncated]';
  const room = Math.max(0, budget - bytes(marker));
  let cut = line;
  while (bytes(cut) > room) cut = cut.slice(0, -Math.max(1, Math.ceil((bytes(cut) - room) / 4)));
  return cut + marker;
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
  const ordered = [...messages].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const candidates = options.since ? ordered.filter((m) => m.ts > options.since!) : ordered;
  if (candidates.length === 0) return { text: '', omitted: 0 };

  // A delta has no root among its candidates — the agent was already shown it.
  const root = options.since ? undefined : candidates[0];
  const rest = root ? candidates.slice(1) : candidates;

  // The root counts against the ceiling like anything else; it used to be
  // included unmeasured.
  const rootLine = root ? fit(render(root), options.budgetBytes) : '';
  let used = bytes(rootLine);
  const tail: { message: ThreadMessage; line: string }[] = [];
  for (const [i, message] of [...rest].reverse().entries()) {
    // The newest reply is always kept — dropping it would either lose what the
    // member just pointed at, or advance the cursor past something never shown,
    // and a skipped message never comes back. Trimmed to the ceiling, though,
    // rather than exempted from it.
    const line = i === 0 ? fit(render(message), options.budgetBytes - used) : render(message);
    const cost = bytes(line) + 1;
    if (i > 0 && used + cost > options.budgetBytes) break;
    used += cost;
    tail.unshift({ message, line });
  }

  const omitted = rest.length - tail.length;
  // No assertion on the tail: an earlier draft read the last element of an empty
  // array and crashed. Absent is also the safe answer — a cursor that does not
  // move is a turn re-read, where one that moves too far is work never seen.
  const newest = tail.at(-1)?.message ?? root;
  const note = omitted
    ? [`… ${omitted} earlier ${omitted === 1 ? 'reply' : 'replies'} omitted to fit the budget …`]
    : [];
  // The note sits where the messages were dropped from, so the gap is visible in
  // place rather than as a footnote about the thread as a whole.
  const shown = tail.map((t) => t.line);
  const lines = root ? [rootLine, ...note, ...shown] : [...note, ...shown];
  return { text: lines.join('\n'), ...(newest ? { seenThroughTs: newest.ts } : {}), omitted };
}
