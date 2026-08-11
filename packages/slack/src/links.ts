/**
 * Slack permalinks pasted into a member's message, resolved into the thread
 * they point at — before the prompt leaves for the agent.
 *
 * The agent runs on the member's machine with whatever access *it* has, which
 * for Slack is usually none and occasionally somebody else's workspace. A link
 * the bot leaves unresolved arrives as a bare URL, and the answer becomes the
 * agent explaining what it cannot open. The bot is the one holding a token for
 * this workspace, so fetching is its job.
 *
 * Rides the prompt, not the context, and that is load-bearing: the driver drops
 * context when a resume is honoured, since the session already has its thread —
 * but a link pasted into *this* message is new to that session too.
 */
import { threadSnapshot, type ThreadMessage } from './snapshot.js';

/** One message a permalink names: `p<sec><usec>` is its ts with the dot taken
 * out, and `thread_ts` rides along when that message is a reply — pointing at
 * the root, which is the thread the member means. */
const PERMALINK =
  /https:\/\/[a-z0-9][a-z0-9.-]*\.slack\.com\/archives\/([A-Z][A-Z0-9]{5,})\/p(\d{10})(\d{6})(?!\d)(\?[^\s>|]*)?/g;

/** Fetches are API calls and threads can be long; past this the member is
 * pasting an index, not a question. The rest are named as unread. */
export const LINKS_PER_MESSAGE = 5;

export interface SlackLink {
  /** As it appeared, query and all — the name the member and the agent both
   * know it by. */
  url: string;
  channel: string;
  /** The thread to fetch: `thread_ts` where the link is to a reply, else the
   * message's own ts. `conversations.replies` on a root returns the whole
   * thread, replies included. */
  root: string;
}

/** Every distinct thread the message links to, in order of first appearance.
 * Distinct by thread, not by URL: two replies in one thread are one fetch. */
export function slackLinks(text: string): SlackLink[] {
  const seen = new Set<string>();
  const links: SlackLink[] = [];
  for (const hit of text.matchAll(PERMALINK)) {
    const [url, channel, sec, usec, query] = hit;
    const reply = query?.match(/[?&]thread_ts=(\d+\.\d+)/);
    const root = reply?.[1] ?? `${sec!}.${usec!}`;
    const key = `${channel!}/${root}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url, channel: channel!, root });
  }
  return links;
}

export interface ResolvedLinks {
  /** One per readable link, labelled with its URL, ready to ride the prompt. */
  sections: string[];
  /** The URLs of links that could not be read — a channel the bot is not in,
   * another workspace entirely, a thread that is gone. */
  unread: string[];
  /** Read, but nothing of it fit beside the links before it — a different fact
   * from `unread`, and the copy must not claim otherwise. */
  crowded: string[];
  /** Links past `LINKS_PER_MESSAGE`, left unfetched on purpose. */
  skipped: number;
  /** Bytes the sections took, charged against the same ceiling as the rest of
   * the injected context. */
  spent: number;
}

/**
 * Fetch what the message links to. Fails open per link: this is context, not
 * the answer, and one dead link must not cost the others or the turn.
 */
export async function resolveLinks(
  text: string,
  deps: {
    budgetBytes: number;
    threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
    log: (message: string) => void;
    /** The conversation's own thread. A link to it resolves to what the turn
     * already carries, so it is not worth a fetch. */
    self?: { channel: string; root: string };
  },
): Promise<ResolvedLinks> {
  const links = slackLinks(text).filter(
    (link) => !(link.channel === deps.self?.channel && link.root === deps.self.root),
  );
  const taking = links.slice(0, LINKS_PER_MESSAGE);
  const sections: string[] = [];
  const unread: string[] = [];
  const crowded: string[] = [];
  let spent = 0;
  for (const link of taking) {
    const messages = await deps.threadReplies(link.channel, link.root).catch((error: unknown) => {
      deps.log(`link not read: ${String(error)}`);
      return undefined;
    });
    if (!messages) {
      unread.push(link.url);
      continue;
    }
    // "Fetched just now" tells the agent it need not reach for Slack itself —
    // and does not tell it not to, since one with real access can go deeper.
    // The label is charged like the snapshot it introduces, with room for the
    // omitted suffix, or the assembled prompt is over a ceiling its own parts
    // were each inside.
    const label = `Behind ${link.url}, fetched just now`;
    // Greedy in the member's order: the first link is the one the message is
    // most likely about, and an even split starves it for a footnote.
    const snapshot = threadSnapshot(messages, {
      budgetBytes: Math.max(0, deps.budgetBytes - spent - Buffer.byteLength(label, 'utf8') - 48),
    });
    if (!snapshot.text) {
      crowded.push(link.url);
      continue;
    }
    const cut = snapshot.omitted
      ? ` (${String(snapshot.omitted)} earlier messages did not fit)`
      : '';
    const section = `${label}${cut}:\n\n${snapshot.text}`;
    sections.push(section);
    spent += Buffer.byteLength(section, 'utf8');
  }
  return { sections, unread, crowded, skipped: links.length - taking.length, spent };
}
