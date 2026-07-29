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
  // Slack ts values are fixed-width decimal strings, so they order lexically.
  const candidates = options.since
    ? messages.filter((m) => m.ts > options.since!)
    : [...messages].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (candidates.length === 0) return { text: '', omitted: 0 };

  // A delta has no root among its candidates — the agent was already shown it.
  const root = options.since ? undefined : candidates[0];
  const rest = root ? candidates.slice(1) : candidates;

  let used = root ? bytes(render(root)) : 0;
  const tail: ThreadMessage[] = [];
  for (const [i, message] of [...rest].reverse().entries()) {
    const cost = bytes(render(message)) + 1;
    // The newest reply is kept whatever it costs. Dropping it would either lose
    // the message the member just pointed at, or advance the cursor past
    // something never shown — and a skipped message never comes back.
    if (i > 0 && used + cost > options.budgetBytes) break;
    used += cost;
    tail.unshift(message);
  }

  const omitted = rest.length - tail.length;
  const kept = [...(root ? [root] : []), ...tail];
  const note = omitted
    ? [`… ${omitted} earlier ${omitted === 1 ? 'reply' : 'replies'} omitted to fit the budget …`]
    : [];
  // The note sits where the messages were dropped from, so the gap is visible in
  // place rather than as a footnote about the thread as a whole.
  const lines = root
    ? [render(root), ...note, ...tail.map(render)]
    : [...note, ...tail.map(render)];
  return { text: lines.join('\n'), seenThroughTs: kept[kept.length - 1]!.ts, omitted };
}
