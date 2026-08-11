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
 * Which makes the bot's reach the thing to be careful about. It reads with its
 * own token and it is in whatever channels anyone invited it to, so "fetch what
 * this member linked" would hand any member the contents of any channel the bot
 * can see, theirs or not. Nothing is fetched without `mayRead` saying the member
 * could have read it themselves.
 */
import { threadSnapshot, type ThreadMessage } from './snapshot.js';

const omittedNote = (n: number): string => ` (${String(n)} earlier messages did not fit)`;

/** One message a permalink names: `p<sec><usec>` is its ts with the dot taken
 * out, and `thread_ts` rides along when that message is a reply — pointing at
 * the root, which is the thread the member means. */
const PERMALINK =
  /https:\/\/([a-z0-9][a-z0-9.-]*\.slack\.com)\/archives\/([A-Z][A-Z0-9]{5,})\/p(\d{10})(\d{6})(?!\d)(\?[^\s>|]*)?/g;

/** Fetches are API calls and threads can be long; past this the member is
 * pasting an index, not a question. The rest are named, not fetched. */
export const LINKS_PER_MESSAGE = 5;

/** Room for the note a label gains when the snapshot under it was cut. Reserved
 * before the cut, because the label is written after it and would otherwise put
 * the section over the ceiling its own parts were each inside. Measured against
 * a count no thread reaches, so it is the worst case rather than a guess at
 * one. */
const OMITTED_NOTE_BYTES = Buffer.byteLength(omittedNote(999_999), 'utf8');

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

/**
 * Every distinct thread the message links to, in order of first appearance.
 * Distinct by thread, not by URL: two replies in one thread are one fetch.
 *
 * `host` is this workspace's own, and a link from anywhere else is not a link
 * to anything here: a channel id only means something in the workspace that
 * issued it, so fetching a foreign one by `(channel, ts)` would answer with
 * whatever our own workspace has at those ids — a different thread than the URL
 * names, under a label claiming otherwise.
 */
export function slackLinks(text: string, host?: string): SlackLink[] {
  const seen = new Set<string>();
  const links: SlackLink[] = [];
  for (const hit of text.matchAll(PERMALINK)) {
    const [url, from, channel, sec, usec, query] = hit;
    if (host && from !== host) continue;
    const reply = query?.match(/[?&]thread_ts=(\d+\.\d+)/);
    const root = reply?.[1] ?? `${sec!}.${usec!}`;
    const key = `${channel!}/${root}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url, channel: channel!, root });
  }
  return links;
}

/** Why a link the member pasted is not in the prompt. Each is a different thing
 * to tell them, and one told as another sends them to fix the wrong thing — a
 * channel the bot cannot see reads as a permissions problem where a thread the
 * budget squeezed out is a longer message. */
export type LinkMiss = {
  url: string;
  why: 'not yours' | 'unreadable' | 'too long' | 'too slow' | 'over the cap';
};

export interface ResolvedLinks {
  /** One per fetched link, labelled with its URL, ready to ride the prompt. */
  sections: string[];
  missed: LinkMiss[];
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
    /** Whether this member could have read that channel themselves — and where
     * not, which of the reasons it is, since the caller is the one that knows.
     * The bot's own access is not the question; see the note at the top. */
    mayRead: (channel: string) => Promise<'yes' | 'not yours' | 'unreadable'>;
    threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
    log: (message: string) => void;
    /** This workspace's `something.slack.com`, where it is known. */
    host?: string;
    /** The conversation's own thread. A link to it resolves to what the turn
     * already carries, so it is not worth a fetch. */
    self?: { channel: string; root: string };
    /** True once these reads have taken long enough. They happen before the
     * acknowledgement, so a stalled one is a member watching nothing happen. */
    spent: () => boolean;
    /** Stops waiting on one read at the same deadline. Sampling between links
     * bounds five quick calls; it does nothing about the first one never
     * answering, which is the shape a stalled Slack takes. */
    reading: <T>(read: Promise<T>) => Promise<T | 'too slow'>;
  },
): Promise<ResolvedLinks> {
  const links = slackLinks(text, deps.host).filter(
    (link) => !(link.channel === deps.self?.channel && link.root === deps.self.root),
  );
  // The logger is a caller's callback, and both places below are recovery
  // paths: one that throws would turn a link the bot merely could not read into
  // a turn that never reached its acknowledgement.
  const say = (line: string): void => {
    try {
      deps.log(line);
    } catch {
      /* a caller's logger is not worth the turn */
    }
  };
  const sections: string[] = [];
  const missed: LinkMiss[] = [];
  let fetches = 0;
  let spent = 0;
  for (const link of links) {
    const miss = (why: LinkMiss['why']): number => missed.push({ url: link.url, why });
    // The cap is on fetches, not on links: a refusal costs Slack nothing, so
    // spending the allowance on one would let an early bad link push a readable
    // one out of a message that never made five requests.
    if (fetches >= LINKS_PER_MESSAGE) {
      miss('over the cap');
      continue;
    }
    if (deps.spent()) {
      miss('too slow');
      continue;
    }
    // Under the same deadline as the fetch below, since it is a Slack call too
    // and one that stalls holds the acknowledgement just as long. Fails closed:
    // not knowing whether the member may read it is not permission, and this
    // gate is the whole reason the bot's reach is not handed to whoever pastes
    // a link.
    const allowed = await deps.reading(deps.mayRead(link.channel)).catch((error: unknown) => {
      // Still refused, but reported as the bot's problem, which it is: a
      // check that threw is no evidence about *them*, and "not yours" would
      // send a member auditing their membership over a missing scope.
      say(`link access unknown: ${String(error)}`);
      return 'unreadable' as const;
    });
    if (allowed !== 'yes') {
      miss(allowed);
      continue;
    }
    fetches += 1;
    const messages = await deps
      .reading(deps.threadReplies(link.channel, link.root))
      .catch((error: unknown) => {
        say(`link not read: ${String(error)}`);
        return undefined;
      });
    if (messages === 'too slow') {
      miss('too slow');
      continue;
    }
    if (!messages) {
      miss('unreadable');
      continue;
    }
    // "Fetched just now" tells the agent it need not reach for Slack itself —
    // and does not tell it not to, since one with real access can go deeper.
    // Charged like the snapshot it introduces, or the assembled prompt is over
    // a ceiling its own parts were each inside.
    const label = `Behind ${link.url}, fetched just now`;
    // Greedy in the member's order: the first link is the one the message is
    // most likely about, and an even split starves it for a footnote.
    const snapshot = threadSnapshot(messages, {
      budgetBytes: Math.max(
        0,
        deps.budgetBytes - spent - Buffer.byteLength(label, 'utf8') - OMITTED_NOTE_BYTES,
      ),
    });
    if (!snapshot.text) {
      miss('too long');
      continue;
    }
    const cut = snapshot.omitted ? omittedNote(snapshot.omitted) : '';
    const section = `${label}${cut}:\n\n${snapshot.text}`;
    sections.push(section);
    spent += Buffer.byteLength(section, 'utf8');
  }
  return { sections, missed, spent };
}
