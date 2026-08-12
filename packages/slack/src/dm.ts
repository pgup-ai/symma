/**
 * A message in the DM. Replying in a thread resumes the conversation that thread
 * is; a top-level message opens one with no source (§4).
 *
 * The turn is recorded, then run on the member's own machine — or refused in
 * §3's words when that machine cannot take it. A follow-up reattaches to the
 * session the last turn ran in when the gateway still offers one, and is caught
 * up from this thread when it does not — both travel, because which applies is
 * not known until the agent has been asked (§4).
 */
import type {
  PromptAttachment,
  SessionModels,
  SessionModes,
  TurnTarget,
  TurnUsage,
} from '@symma/protocol';

import {
  collectAttachments,
  skippedNote,
  type FetchedFile,
  type SlackFile,
} from './attachments.js';

import type { ConversationRef } from './mention.js';
import { decideTurn, type RefusalReason } from './presence.js';
import { LINKS_PER_MESSAGE, resolveLinks, slackLinks, type LinkMiss } from './links.js';
import { plainly, type MarkState, type TurnStream, type UpdateBudget } from './slack-api.js';
import { threadSnapshot, type ThreadMessage } from './snapshot.js';

export interface DmMessage {
  /** Who is asking. Their access is the one that decides what a link in this
   * message may be resolved into — never the bot's, which is the union of
   * everyone's invitations. */
  user: string;
  /** The DM channel, always a `D` id — resolved by Slack, not by us. */
  channel: string;
  ts: string;
  /** Absent on a top-level message, which is then its own root. */
  threadTs?: string;
  eventId: string;
  /** What they asked, as Slack sent it: `<@U123>` and `<#C123>` stay unresolved,
   * since expanding them is a lookup each and the question is about code. */
  text: string;
  /** What they attached, as Slack described it. Fetched rather than named: an
   * agent told a CSV exists can only say so back. */
  files?: SlackFile[];
}

/**
 * Whether a `message` event is a member speaking in their own DM. A function
 * with a test rather than a condition in the handler, because the bot's own
 * posts arrive on this subscription and answering one is an infinite loop.
 * A `subtype` is an edit, a delete or a join: nothing to answer. `file_share` is
 * the exception — Slack files a member's upload under it, caption and all
 * (docs.slack.dev/reference/events/message/file_share, checked 2026-08), so
 * refusing every subtype would drop the attachment path's own messages in
 * silence: no acknowledgement, no refusal, nothing in the DM at all.
 */
export function isMemberDm(event: Record<string, unknown>): boolean {
  return (
    event.type === 'message' &&
    event.channel_type === 'im' &&
    event.bot_id === undefined &&
    (event.subtype === undefined || event.subtype === 'file_share') &&
    typeof event.user === 'string' &&
    typeof event.channel === 'string' &&
    typeof event.ts === 'string'
  );
}

/** `refused` names why, so a support question is answered by the log line rather
 * than by asking the member what they saw. `failed` is a run that started. */
export type DmOutcome =
  | 'resumed'
  | 'opened'
  | 'already handled'
  | 'still working'
  | 'nothing to ask'
  | 'failed'
  | `refused: ${RefusalReason}`;

/** One prompt on one machine, in one of the directories it offers. */
export interface RunSpec {
  conversation: string;
  endpoint: string;
  agent: string;
  token: string;
  prompt: string;
  /** Absent for a machine that advertises no roots — the agent then opens in an
   * empty temp directory, which the acknowledgement says out loud. */
  workspace?: string;
  /** `provider/model`, always — every spec parses it that way and reads the half
   * after the slash. A bare `default` is refused before any agent sees it. */
  model: string;
  /** The conversation's session mode, as the gateway served it (§4). Absent is
   * read-only. */
  mode?: string;
  /** A session to pick up, and what to catch a fresh one up with instead. Both
   * travel: which applies is not known until the agent has been asked. */
  resume?: string;
  context?: string;
  /** What the agent is doing, for the acknowledgement to show while it runs. */
  onProgress?: (title: string) => void;
  /** The agent thinking out loud, in fragments — reassembled and throttled
   * here, rendered as the open card's detail line. */
  onThought?: (text: string) => void;
  /** Handed a way to cancel the running turn, once there is a session to
   * cancel into. */
  onCancelable?: (cancel: () => void) => void;
  /** The member's own files, already fetched, for the agent to read. */
  attachments?: PromptAttachment[];
}

/** One turn's own floor, under the budget it shares with every other turn: a
 * step every few seconds is a member watching frames nobody reads, and it would
 * take that budget on its own before a second turn had asked for any. Long
 * enough to be cheap, short enough that a run still looks like it is moving. */
const PROGRESS_MIN_MS = 10_000;

/** The stream's own floor, shorter: a card flipping every few seconds is what
 * "live" means, `chat.appendStream` allows twice what `chat.update` does, and a
 * card is a line in a list rather than a rewrite of the whole message. */
const STREAM_MIN_MS = 3_000;

/** How long the answer's own handler will wait on the update that tidies the
 * acknowledgement, for a line the member is not waiting for. Landing late is
 * harmless: nothing else writes that message after the turn that posted it.
 *
 * The Slack implementation bounds the call itself as well, and this stays because
 * `working` is a seam: what is behind it decides how long a `chat.update` may
 * take, and how long this handler is willing to be held is not that layer's
 * decision to make. */
const TIDY_MS = 10_000;

/** A tool-call title on its way into a mrkdwn *italic* span, so an underscore
 * closes it as surely as a backtick does. Clamped, since a title is a label. */
const asStep = (title: string): string =>
  plainly(title).replaceAll('_', ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** A thought buffer on its way into a card's detail line — the tail, because
 * the freshest thinking is the end of it, and a detail line is a glance, not a
 * log. Clamped under the 256 bytes a task chunk field takes. */
const asThought = (buffer: string): string =>
  plainly(buffer).replace(/\s+/g, ' ').trim().slice(-250);

/** The card a turn thinks under before it has called a single tool. */
const THINKING = 'Thinking';

/** Rounded: what a member does with a token count is notice a turn that cost
 * ten times the last one. */
const thousands = (tokens: number): string =>
  tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;

/** Measured on what was not cached, not on the total: the context a workspace
 * turn carries is re-sent every turn whether it did any work or not, so a total
 * crosses any bar the moment `AGENTS.md` is big, which is every turn. What is
 * new to the model is what the turn actually chewed through — a few thousand for
 * a question answered from context, an order more for one that read the repo. */
const EXPENSIVE_TOKENS = 25_000;

/** Enough to see what kind of thing was agreed to; past that a count says more
 * than another name would. */
const NAMED_APPROVALS = 5;

/** The cost beside the model that charged it — the two only mean something
 * together, now that the model is the member's own choice. Absent when the
 * agent reported no total: an invented number is worse than none. Absent for a
 * cheap turn too, since a count on every answer is a number nobody reads and
 * the point of it is noticing the turn that cost ten times the last one. */
function spent(model: string | undefined, usage: TurnUsage | undefined): string[] | undefined {
  if (usage?.totalTokens === undefined) return undefined;
  if (usage.totalTokens - (usage.cachedTokens ?? 0) < EXPENSIVE_TOKENS) return undefined;
  const parts = [
    ...(model ? [`\`${plainly(model)}\``] : []),
    `${thousands(usage.totalTokens)} tokens`,
    ...(usage.cachedTokens ? [`${thousands(usage.cachedTokens)} cached`] : []),
  ];
  return [parts.join(' · ')];
}

/** What a member at their own terminal would have been prompted about, named —
 * "it ran some commands" is not something anyone can check. Refusals are worth as
 * much as approvals: an agent told no by the floor tends to answer around it
 * rather than say which door was shut. */
function approvalNote(approvals?: { title: string; allowed: boolean }[]): string[] {
  const titles = (allowed: boolean): string[] => [
    // One entry each, counted on what the member will read: an agent retrying the
    // same call asked about the same thing, and may well have quoted it
    // differently — two titles that render alike are one line either way.
    ...new Set((approvals ?? []).filter((a) => a.allowed === allowed).map((a) => plainly(a.title))),
  ];
  const line = (lead: string, named: string[]): string[] => {
    if (!named.length) return [];
    // Named up to a point and counted after it. A turn that asked forty times is
    // not a list anyone reads, and the aside carrying it would be cut to fit by a
    // slice that lands wherever it lands — inside a code span as readily as
    // between two names, taking the rest of the line into the span with it.
    const shown = named.slice(0, NAMED_APPROVALS);
    const rest = named.length - shown.length;
    const more = rest ? ` and ${String(rest)} more` : '';
    return [`${lead}: ${shown.map((title) => `\`${title}\``).join(', ')}${more}.`];
  };
  return [
    ...line('Went ahead without asking', titles(true)),
    ...line('Would not run', titles(false)),
  ];
}

/** Which files the agent had no block for, grouped by kind — one sentence per
 * kind, because a rejected image and a rejected CSV are refused for different
 * reasons and naming them together would misdescribe one of them. */
function unsupportedNote(agent: string, files?: { name: string; kind: string }[]): string[] {
  const byKind = new Map<string, string[]>();
  for (const file of files ?? []) {
    byKind.set(file.kind, [...(byKind.get(file.kind) ?? []), plainly(file.name)]);
  }
  return [...byKind].map(
    ([kind, names]) =>
      `${names.join(', ')} did not reach ${agent}: it takes no ${kind} attachments.`,
  );
}

/** What the answer can offer to change for the next turn, or nothing. */
function pickers(
  conversation: string,
  agent: string,
  answer: { modes?: SessionModes; models?: SessionModels },
  inWorkspace: boolean,
):
  | { conversation: string; agent: string; modes?: SessionModes; models?: SessionModels }
  | undefined {
  const offer = {
    ...(answer.modes && inWorkspace ? { modes: answer.modes } : {}),
    ...(answer.models ? { models: answer.models } : {}),
  };
  return Object.keys(offer).length ? { conversation, agent, ...offer } : undefined;
}

/** These reads sit in front of the acknowledgement, so a Slack call that never
 * settles is a member watching nothing happen. Generous — five threads is a
 * real fetch — but finite. */
const LINKS_MS = 8_000;

/** The workspace lookup's slice of it. One `auth.test`, cached after it lands,
 * so a slow one is a first message on a degraded Slack — and bounding it to the
 * whole budget would leave the links it is there to check with none. Short,
 * because the fallback is benign: the pin comes off and the access check is
 * what was guarding the fetch anyway. */
const HOST_MS = 1_000;

/**
 * Stops waiting on `work` after `ms`, without stopping `work` — the Slack SDK
 * takes no signal, and a request finishing into a void costs nothing. Two jobs
 * on the one handle: `unref` so waiting on something nobody reads cannot be the
 * last thing holding the process open, and the clear so a deadline that lost
 * its race, or a rejection that skipped past it, is not left pending — one
 * handle per read adds up under traffic.
 */
async function before<T>(ms: number, work: Promise<T>): Promise<T | 'too slow'> {
  let late: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'too slow'>((resolve) => {
        late = setTimeout(() => resolve('too slow'), Math.max(0, ms));
        late.unref();
      }),
    ]);
  } finally {
    clearTimeout(late);
  }
}

/** Why a link the member pasted is not in the prompt, in their words. Their
 * next move differs by which it was: a channel that is not theirs is not a
 * message that was too long. */
const WHY: Record<LinkMiss['why'], string> = {
  'not yours': 'it is not a channel you are in',
  unreadable: 'I cannot read it',
  'too long': 'it did not fit',
  'too slow': 'Slack was too slow',
  'over the cap': `I take ${String(LINKS_PER_MESSAGE)} links per message`,
};

export interface DmDeps {
  find: (dmChannel: string, rootThread: string) => Promise<ConversationRef | undefined>;
  /** The machine this member's agent would run on, whatever state it is in, and
   * what it takes to drive it. Undefined when they have paired none. */
  endpoint: (conversation: string) => Promise<TurnTarget | undefined>;
  turn: (spec: {
    dmChannel: string;
    rootThread: string;
    slackEventId: string;
  }) => Promise<{ conversation: ConversationRef; turn?: string; refused?: 'duplicate' | 'busy' }>;
  /** Drives one prompt to its answer on the member's machine. Rejects rather
   * than returning a failure, so the transport's own errors arrive intact.
   * `notices` is what the agent said about itself rather than about the
   * question, kept apart so the answer is not read as carrying it. `session` is
   * where it ran, for the next turn in this thread to pick up. */
  run: (spec: RunSpec) => Promise<{
    text: string;
    notices: string[];
    session: string;
    /** How the member picks this session up in their own terminal, when the
     * agent has such a command. */
    resumeWith?: string;
    modes?: SessionModes;
    models?: SessionModels;
    /** What the turn cost, when the agent said. */
    usage?: TurnUsage;
    /** Files the agent advertised no block for, for this layer to word. */
    unsupported?: { name: string; kind: string }[];
    /** Permission decisions made without the member present. */
    approvals?: { title: string; allowed: boolean }[];
  }>;
  /** Clears the conversation's stored mode. Called when a turn failed because
   * the agent no longer offers it — the picker that could fix it only rides
   * answers, so without this the thread would fail every turn from here on. */
  shedMode: (conversation: string) => Promise<void>;
  /** The same for the model: ids belong to an agent's roster, so a pick made
   * under one can throw under another and would repeat until it is cleared. */
  shedModel: (conversation: string) => Promise<void>;
  /** Downloads one of the member's Slack files. */
  fetchFile: (url: string, maxBytes: number) => Promise<FetchedFile>;
  /** Rewrites the acknowledgement while the run is out, so a long turn shows
   * it is still moving. Fails open, like every hint here. */
  working: (channel: string, ts: string, text: string) => Promise<void>;
  /** Ends the turn, and remembers the session it ran in when there was one —
   * against what it ran under, since an id means nothing on another machine,
   * agent or directory. Every path that opened a turn calls this, including the
   * ones that never ran: a turn left open tells the next message the thread is
   * still busy. Fails open, like every auxiliary write. */
  finish: (
    conversation: string,
    turn: string,
    status: 'completed' | 'failed' | 'cancelled',
    ran?: { session: string; endpoint: string; agent: string; workspace?: string },
  ) => Promise<void>;
  /** The DM thread itself, which is the durable transcript a follow-up is
   * caught up from. Undefined when the bot cannot read the channel. */
  threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
  /** This workspace's own host, for pinning pasted links to it. */
  host: () => Promise<string | undefined>;
  /** What the bot can say about a channel: anyone's, its own to see but not to
   * vouch for, or not visible to it at all. */
  visibility: (channel: string) => Promise<'public' | 'private' | 'unseen'>;
  /** Every conversation this member is in — the other way a link is theirs to
   * read. Undefined where the scan failed, which is not the same as none. */
  conversationsOf: (user: string) => Promise<Set<string> | undefined>;
  /** Room on the acknowledgement, shared by every turn at once: Slack counts
   * `chat.update` per app rather than per channel, so this is the ceiling a
   * per-turn interval cannot be. */
  updates: UpdateBudget;
  /** Room on the stream — `chat.appendStream` is its own pool, shared the same
   * way. */
  appends: UpdateBudget;
  /** The thinking-steps stream for this turn's narration, opened on the first
   * step. Undefined where the workspace refuses one, and the turn narrates onto
   * the acknowledgement instead. */
  stream: (
    channel: string,
    thread: string,
    first: string,
    thought?: string,
  ) => Promise<TurnStream | undefined>;
  /** Routes a member pressing Slack's stop on this stream back to the turn
   * that owns it. Returns the unhook, called once the turn is over: the map
   * this writes outlives the turn, and a stale entry would stop whichever
   * turn's stream is minted at the same ts next. */
  stoppable: (channel: string, ts: string, halt: () => void) => () => void;
  /** The same ceiling a mention's context runs under (§4). */
  budgetBytes: number;
  post: (
    channel: string,
    text: string,
    threadTs?: string,
    offerShare?: { conversation: string; destination: string },
    notices?: string[],
    pickers?: {
      conversation: string;
      agent: string;
      modes?: SessionModes;
      models?: SessionModels;
    },
  ) => Promise<{ channel: string; ts: string }>;
  /** Marks the member's own message for the length of the run. Only the run is
   * worth marking — everything refused answers in words, immediately. */
  mark: (channel: string, ts: string, state: MarkState) => Promise<void>;
  /** Where this conversation may publish (§5). Undefined for one that began in
   * the DM, which has nowhere to go back to. */
  destination: (conversation: string) => Promise<{ channel: string; thread: string } | undefined>;
  /** Moves the conversation's cursor up its source thread. Called only after the
   * answer is delivered: a turn that failed to reach the member must not leave
   * the channel marked as read to the agent that never saw it. */
  seen: (conversation: string, seenThroughTs: string) => Promise<void>;
  log: (message: string) => void;
}

/** Said to the agent, not the member: one that believes it still holds the files
 * it opened will answer about a session that is gone. */
const REPLAY =
  'Earlier in this conversation, most recent last. This is a transcript, not a ' +
  'session you can still reach — files you opened and commands you ran are gone, ' +
  'so re-read anything you need.';

/** Labels the channel thread a mention came out of, which the member can see and
 * the agent cannot. Distinct from the replay below because they are different
 * conversations: one is what was asked about, the other what was said about it. */
const SOURCE = 'The thread this was asked in, most recent last:';

/**
 * §4's third rung, and still the one every follow-up needs to hand over: a
 * resume is an offer until the agent answers it, so this is what a turn that
 * ends up in a fresh session arrives with. The DM thread is the transcript —
 * the messages the member can scroll — under the byte ceiling a mention's
 * context already runs under.
 *
 * The member's own message is dropped: Slack returns the whole thread including
 * the one being handled, and the prompt carries it once on its own. A thread
 * that cannot be read catches nothing up rather than failing the turn.
 */
async function catchUp(
  message: DmMessage,
  conversation: ConversationRef,
  deps: DmDeps,
): Promise<{ context?: string; note: string; seenThrough?: string } | undefined> {
  // Fails open, per the auxiliary rule: this is context, not the answer.
  // `threadReplies` throws on a thread past its page cap and on any Slack error
  // that is not a plain "cannot see it" — and a conversation long enough to
  // reach that cap is precisely the one worth catching up.
  // Undefined is a thread that could not be read — a channel the bot was removed
  // from, one past its page cap — as against `[]` for one with nothing in it. The
  // difference is worth keeping now: the source thread is no longer copied into
  // the DM, so losing it is losing the question's context rather than a duplicate
  // of it.
  const read = (channel: string, thread: string): Promise<ThreadMessage[] | undefined> =>
    deps.threadReplies(channel, thread).catch((error: unknown) => {
      deps.log(`catch-up skipped: ${String(error)}`);
      return undefined;
    });

  // Read at the turn rather than copied into the DM when the mention landed, which
  // is also reading it as it is now. It takes the budget it needs and the DM gets
  // the rest: a member asking about a channel thread would rather lose their own
  // earlier asides than the thread.
  // A section costs its label, the blank line under it, and the one joining it to
  // the next. Charged against the same ceiling as the text it introduces, or the
  // assembled context is over a budget its own parts were each inside. Clamped
  // because the labels are fixed where the ceiling is configured.
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
  const room = (label: string, taken = 0): number =>
    Math.max(0, deps.budgetBytes - taken - bytes(label) - 4);

  const from = conversation.source;
  const channel = from ? await read(from.channel, from.thread) : [];
  const source = from
    ? threadSnapshot(channel ?? [], {
        budgetBytes: room(SOURCE),
        ...(conversation.seenThroughTs ? { since: conversation.seenThroughTs } : {}),
      })
    : undefined;
  const spent = source?.text ? bytes(SOURCE) + 4 + bytes(source.text) : 0;

  const replies = (await read(conversation.dmChannel, conversation.rootThread)) ?? [];
  const dm = threadSnapshot(
    replies.filter((reply) => reply.ts !== message.ts),
    { budgetBytes: room(REPLAY, spent) },
  );
  const parts = [
    ...(source?.text ? [`${SOURCE}\n\n${source.text}`] : []),
    ...(dm.text ? [`${REPLAY}\n\n${dm.text}`] : []),
  ];
  const omitted = (source?.omitted ?? 0) + dm.omitted;
  // Said rather than absorbed: an answer given without the thread it was asked
  // about reads like an answer about the thread, and the member is the only one
  // who can tell the difference or fix the access. Said even with nothing to catch
  // up on, which is why the context is what is optional here and the note is not.
  const lost = from && !channel ? from.channel : undefined;
  if (!parts.length && !lost) return undefined;
  return {
    ...(parts.length ? { context: parts.join('\n\n') } : {}),
    note: lost
      ? `I cannot read <#${lost}> just now, so this is without that thread.`
      : omitted
        ? `Catching it up, minus ${String(omitted)} earlier messages that did not fit.`
        : 'Catching it up from the thread — it has the messages, not what it ran.',
    ...(source?.seenThroughTs ? { seenThrough: source.seenThroughTs } : {}),
  };
}

/**
 * A message becomes a turn in the conversation its root names, and opens one
 * where that root has none — whether the root is this message or the thread it
 * sits in.
 *
 * An earlier version ignored a threaded reply whose root it did not recognise,
 * on the grounds that the bot never posted that ts. That reasoning did not hold:
 * a top-level DM is already rooted at a ts the bot never posted, so the two
 * branches disagreed. It also dropped a real message — replies are delivered
 * concurrently, so one sent straight after its root can arrive while the root is
 * still being opened, and being ignored is the one answer a member cannot see.
 */
export async function handleDm(message: DmMessage, deps: DmDeps): Promise<DmOutcome> {
  const rootThread = message.threadTs ?? message.ts;
  const existing = await deps.find(message.channel, rootThread);

  const { conversation, turn, refused } = await deps.turn({
    dmChannel: message.channel,
    rootThread,
    slackEventId: message.eventId,
  });
  // A thread is a sequence. Two turns at once fork the agent session that
  // carries it, and neither half then holds the whole conversation — so the
  // second one waits, and is told rather than left wondering. Before the guard
  // below, which a refusal also trips: neither kind carries a turn.
  if (refused === 'busy') {
    await deps.post(
      conversation.dmChannel,
      'Still on your previous message in this thread — send this again when that lands. A new thread here runs alongside it.',
      conversation.rootThread,
    );
    return 'still working';
  }
  // Recorded before anything is posted, so a Slack redelivery answers with
  // silence rather than a second acknowledgement.
  if (!turn) return 'already handled';

  // A file with no caption is an ordinary message with an empty prompt. Caught
  // before the ask below, so it neither mints a token nor starts a run.
  if (!message.text.trim()) {
    // Closed before the post, not after: this turn is already decided, and a
    // Slack error here would otherwise hold the thread until it went stale.
    await deps.finish(conversation.id, turn, 'cancelled');
    await deps.post(
      conversation.dmChannel,
      'Send me a question with that and I will pass it to your agent.',
      conversation.rootThread,
    );
    return 'nothing to ask';
  }

  // Asked after the dedupe gate, so a redelivery costs the gateway nothing —
  // and, since asking mints a token, costs it no credential either.
  const decision = decideTurn(await deps.endpoint(conversation.id));
  if (!decision.run) {
    await deps.finish(conversation.id, turn, 'cancelled');
    await deps.post(conversation.dmChannel, decision.why, conversation.rootThread);
    return `refused: ${decision.because}`;
  }

  // First claim on the budget: the link is what this message is about, where
  // the catch-up below is background. Nothing at all for a message with no link
  // in it, which is nearly all of them — the reads here are API calls, and no
  // ordinary turn should pay for a feature it is not using.
  //
  // One deadline over the whole resolution, permission checks included — they
  // are Slack calls too, and five quick reads or one that never answers are the
  // same wait to a member watching for the acknowledgement.
  const links = slackLinks(message.text);
  const by = Date.now() + LINKS_MS;
  const within = <T>(read: Promise<T>): Promise<T | 'too slow'> => before(by - Date.now(), read);
  // Bounded like every other Slack call here, and to a slice rather than the
  // lot: unbounded it delays the acknowledgement past the ceiling, and given
  // the ceiling it spends what the links were for. Unknown is a state this
  // already has words for — the pin comes off, and the access check below is
  // what was keeping anyone honest anyway.
  const found = links.length ? await before(HOST_MS, deps.host()) : undefined;
  const known = found === 'too slow' ? undefined : found;
  // One scan of this member's conversations for the whole message, however many
  // links it holds: their list is short, but reading it once per link is
  // latency in front of the acknowledgement buying no new answer.
  let mine: Promise<Set<string> | undefined> | undefined;
  const linked = links.length
    ? await resolveLinks(message.text, {
        budgetBytes: deps.budgetBytes,
        threadReplies: deps.threadReplies,
        log: deps.log,
        ...(known ? { host: known } : {}),
        // What this member could have opened themselves — never what the bot
        // can see, which is the union of everyone's invitations. A public
        // channel is theirs by definition; their own DM with it arrived this
        // turn; anything else has to have them in it.
        //
        // A channel the bot cannot see is its own answer. Slack restricts the
        // membership list to conversations the *bot* shares with them, so a
        // private channel it was never invited to is one it cannot tell them
        // about — and "you are not in that channel" would be a guess, usually
        // wrong, about the one thing they can check for themselves.
        mayRead: async (channel) => {
          if (channel === conversation.dmChannel) return 'yes';
          const seen = await deps.visibility(channel);
          if (seen === 'public') return 'yes';
          if (seen === 'unseen') return 'unreadable';
          const theirs = await (mine ??= deps.conversationsOf(message.user));
          // A scan that failed is not a member standing outside the channel.
          // Only a list that arrived can say they are not in it.
          if (!theirs) return 'unreadable';
          return theirs.has(channel) ? 'yes' : 'not yours';
        },
        self: { channel: conversation.dmChannel, root: conversation.rootThread },
        spent: () => Date.now() > by,
        reading: within,
      })
    : { sections: [], missed: [], spent: 0 };

  // Even when a resume is on offer, because whether the agent still has that
  // session is not known until it has been asked — and arriving without the
  // thread is the half that cannot be recovered from (§4).
  const caught = existing
    ? await catchUp(message, conversation, {
        ...deps,
        budgetBytes: Math.max(0, deps.budgetBytes - linked.spent),
      })
    : undefined;

  // Fetched before the run so a refusal is one aside rather than a failed turn,
  // and after the endpoint check so a shut laptop costs no downloads.
  const attached = message.files?.length
    ? await collectAttachments(message.files, deps.fetchFile)
    : [];
  const attachments = attached.flatMap((entry) => (entry.ok ? [entry.file] : []));

  // A run takes minutes and Slack gives a bot no typing indicator, so this
  // message is what says the question landed — and §4 wants it to carry the
  // scope rather than leave it guessed at. A status line rather than a sentence
  // because it is also what the message reads as at rest, above the finished
  // answer. Every turn, since the mode is theirs to change mid-thread and the
  // turn that first ran write-capable is the one that has to say so. Named even
  // when unset: read-only is the floor's truth for a workspace turn that never
  // picked one.
  //
  // Through `plainly` like every other name in this message: a backtick closes
  // the span it sits in, and a `<` opens an entity that renders as a mention
  // once the answer is shared into a channel. Their own machine and their own
  // DM, so this is rendering and not a trust boundary.
  const scope = decision.label
    ? `\`${plainly(decision.label)}\` · \`${decision.mode ?? 'read-only'}\``
    : '`no project` · it cannot see your files, so keep the question self-contained';
  // The offer, not the outcome: the agent has not been asked yet, so this says
  // what will be tried rather than claiming a resume that may not happen. It
  // takes the place of the catch-up note, which describes a transcript a
  // successful resume makes no use of.
  const attempting = decision.resume ? 'Picking up where it left off, if it still can.' : undefined;
  // The acknowledgement with nothing turn-scoped left in it: what the answer was
  // produced without stays true of the answer. Dropped only where the resume was
  // honoured, which is the comparison `driveAcpSession` itself makes to decide
  // whether to send the transcript — a turn whose resume was refused ran on that
  // transcript, and still has to say what was missing from it.
  // Links this answer ran without rest beside the catch-up note, but
  // unconditionally: the fetch rides the prompt, so no resume makes this stop
  // being true.
  const leftOutNote = linked.missed.length
    ? `This ran without ${linked.missed.map((miss) => `<${miss.url}> — ${WHY[miss.why]}`).join(', ')}.`
    : undefined;
  const restingFor = (ranIn: string | undefined): string =>
    [
      scope,
      leftOutNote,
      decision.resume !== undefined && ranIn === decision.resume ? undefined : caught?.note,
    ]
      .filter(Boolean)
      .join(' ');
  const opening = restingFor(decision.resume);
  // Named up front: a member who attached three files and sees two read should
  // learn it now, not from an answer that quietly used one.
  const reading = attachments.length
    ? `Reading ${attachments.map((file) => `\`${plainly(file.name)}\``).join(', ')}.`
    : undefined;
  const following = linked.sections.length
    ? `Reading the ${linked.sections.length > 1 ? 'threads' : 'thread'} behind your ${
        linked.sections.length > 1 ? 'links' : 'link'
      }.`
    : undefined;
  // Said only while the turn is out.
  const inFlight = [attempting, following, reading].filter(Boolean).join(' ');
  // The ellipsis is the "still going" cue, and it belongs to the in-flight text
  // rather than to what rests, which is as true after the answer as before it —
  // so a turn with nothing else to say needs no update to take a cue off a line
  // that never moved. The 👀 on their own message is what says it is running.
  const ack = inFlight ? `${opening} ${inFlight.replace(/\.$/, '')}…` : opening;
  const acked = await deps.post(conversation.dmChannel, ack, conversation.rootThread);

  await deps.mark(message.channel, message.ts, 'working');

  // The agent's own narration — Slack gives a bot no typing indicator, so this
  // is the only place a long turn can show it is still moving. Streamed as task
  // cards under the acknowledgement where the workspace serves a stream, and
  // rewritten onto the acknowledgement itself where it does not. Both throttled
  // and budgeted: either pool is shared by every turn at once, and a busy turn
  // narrates far faster than anyone reads. Fails open throughout — a hint, not
  // the answer.
  //
  // Queued rather than concurrent: two updates in flight on one message can land
  // in either order, and the cleanup below losing that race would leave a step
  // sitting above the answer — the thing it is there to take away.
  let lastShown = 0;
  let reserved: number | undefined;
  let ackWritten = false;
  let steps: Promise<TurnStream | undefined> | undefined;
  let lastStep: string | undefined;
  let fellBack = false;
  let updating = Promise.resolve();
  let unhook: (() => void) | undefined;
  let settling = false;
  /** Wires the opened stream's stop press back to this turn, or falls back. A
   * refused open re-enters `narrate` with the floor reset where there is a
   * step to re-enter with — a pending thought is dropped instead, since the
   * acknowledgement path renders steps and nothing else. Nothing re-enters
   * once the turn is settling: the re-dispatch chains behind the links settle
   * is already waiting on, so its write would land after the tidy and stand
   * over the answer for good. */
  const opened = (title?: string) => (stream: TurnStream | undefined) => {
    if (stream) {
      unhook = deps.stoppable(acked.channel, stream.ts, halt);
      return;
    }
    fellBack = true;
    lastShown = 0;
    if (title !== undefined && !settling) narrate(title);
  };
  const narrate = (title: string): void => {
    const now = Date.now();
    if (now - lastShown < (fellBack ? PROGRESS_MIN_MS : STREAM_MIN_MS)) return;
    const step = asStep(title);
    if (fellBack) {
      // Asked after this turn's own floor, so a quiet turn does not spend the
      // workspace's budget just by being asked, and refused rather than queued:
      // narration is only worth anything while it is current. Two on the first
      // write, because the cleanup below is not optional once a step is written
      // — unreserved, every narrating turn would put one uncounted
      // `chat.update` over the ceiling, and a busy minute would clear it twice.
      const paid = deps.updates.room(ackWritten ? 1 : 2);
      if (paid === undefined) return;
      reserved ??= paid;
      ackWritten = true;
      lastShown = now;
      // Caught on the chain and not on the call, so a `working` that throws
      // where it stands rather than rejecting cannot leave `updating` rejected
      // — every link after it, the cleanup included, would be skipped and the
      // step would stay exactly where this is meant to take it from.
      updating = updating
        .then(() => deps.working(acked.channel, acked.ts, `${ack}\n\n_${step}_`))
        .catch(() => undefined);
      return;
    }
    if (steps === undefined) {
      lastShown = now;
      lastStep = step;
      // The first step rides the open, paid from `chat.startStream`'s own pool.
      // A refused open re-enters above with the floor reset, so the step a
      // fallback workspace would otherwise lose is the one that finds out.
      steps = deps.stream(acked.channel, conversation.rootThread, step);
      updating = steps.then(opened(title)).catch(() => undefined);
      return;
    }
    // One card per step: the same title again is the card already in progress.
    if (step === lastStep) return;
    if (deps.appends.room(1) === undefined) return;
    lastShown = now;
    lastStep = step;
    updating = updating.then(async () => (await steps)?.append(step)).catch(() => undefined);
  };

  // The agent thinking out loud, as the open card's detail line. Fragments
  // pool until the floor lets one through, and the tail is what shows — the
  // freshest thinking is the end of the buffer. Thoughts never reach the
  // acknowledgement path: a rewritten line of reasoning above the answer is
  // noise where a card detail is a glance, so a fallback turn thinks silently.
  let thoughts = '';
  const think = (text: string): void => {
    thoughts += text;
    if (fellBack) return;
    const now = Date.now();
    if (now - lastShown < STREAM_MIN_MS) return;
    const detail = asThought(thoughts);
    if (!detail) return;
    thoughts = '';
    if (steps === undefined) {
      lastShown = now;
      lastStep = THINKING;
      steps = deps.stream(acked.channel, conversation.rootThread, THINKING, detail);
      updating = steps.then(opened()).catch(() => undefined);
      return;
    }
    if (deps.appends.room(1) === undefined) return;
    lastShown = now;
    updating = updating.then(async () => (await steps)?.think(detail)).catch(() => undefined);
  };

  // The member's stop press, routed here from the stream's own button. The
  // cancel lands on the agent as ACP's `session/cancel`, and the turn still
  // resolves through the one path already being awaited — with whatever the
  // agent had; `stopped` is what labels that answer as cut short on purpose.
  let cancelRun: (() => void) | undefined;
  let stopWanted = false;
  let stopped = false;
  const halt = (): void => {
    stopped = true;
    // Both orders are real: a stream opens before the session exists, and a
    // press can land in the gap.
    if (cancelRun) cancelRun();
    else stopWanted = true;
  };

  // The stream folds its cards away when stopped; the acknowledgement cannot
  // fold, so its last step and the ellipsis are in the way once the turn is
  // over. Either close is queued behind the narration it is undoing, and called
  // only after the turn is closed: a call Slack is slow to take would otherwise
  // hold the turn open, and a member's next message would be refused for a line
  // nobody is waiting on. Fail-open like `narrate`, and waited on to a
  // deadline, not indefinitely.
  const settle = async (text: string, last: 'complete' | 'error' = 'complete'): Promise<void> => {
    settling = true;
    unhook?.();
    const closing: Promise<unknown>[] = [];
    if (steps !== undefined)
      closing.push(updating.then(async () => (await steps)?.stop(last)).catch(() => undefined));
    // The acknowledgement needs tidying where narration wrote on it, and where
    // a resume offer left an ellipsis — which a streamed turn still owes, since
    // the cards sit under the acknowledgement rather than on it.
    if (ackWritten || inFlight)
      closing.push(
        updating
          .then(() => {
            // Charged against the call and not against the intention: this
            // waits behind the narration it is undoing, and a reservation still
            // live when that wait began can have aged out by the time the call
            // goes. Taken rather than asked either way — an acknowledgement
            // left mid-step above a delivered answer reports the turn wrongly,
            // where a quiet one is merely quiet.
            deps.updates.take(reserved);
            return deps.working(acked.channel, acked.ts, text);
          })
          .catch(() => undefined),
      );
    if (closing.length) await before(TIDY_MS, Promise.all(closing));
  };

  let answer: {
    text: string;
    notices: string[];
    session: string;
    resumeWith?: string;
    modes?: SessionModes;
    models?: SessionModels;
    usage?: TurnUsage;
    unsupported?: { name: string; kind: string }[];
    approvals?: { title: string; allowed: boolean }[];
  };
  try {
    answer = await deps.run({
      conversation: conversation.id,
      endpoint: decision.endpoint,
      agent: decision.agent,
      token: decision.token,
      // §5 wants a per-agent default with an override; until the override
      // exists this is the default, and the prefix is what makes it parse.
      // The member's pick when they have made one, else the agent's own
      // default. The prefix is what makes it parse either way.
      model: `${decision.agent}/${decision.model ?? 'default'}`,
      // The fetched threads ride the prompt rather than the context: context is
      // dropped where a resume is honoured, and a link pasted into this message
      // is new to that session too. The unread line is for an agent with Slack
      // access of its own — it may reach what the bot cannot.
      prompt: [
        message.text,
        ...linked.sections,
        ...(linked.missed.length
          ? [
              `Not fetched above — read ${linked.missed.length > 1 ? 'them' : 'it'} yourself if you have Slack access: ${linked.missed
                .map((miss) => miss.url)
                .join(', ')}`,
            ]
          : []),
      ].join('\n\n'),
      onProgress: narrate,
      onThought: think,
      onCancelable: (cancel) => {
        cancelRun = cancel;
        if (stopWanted) cancel();
      },
      ...(caught?.context ? { context: caught.context } : {}),
      ...(decision.resume ? { resume: decision.resume } : {}),
      ...(decision.workspace ? { workspace: decision.workspace } : {}),
      ...(decision.mode ? { mode: decision.mode } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
  } catch (error) {
    // Posted into the thread they are watching rather than left to the socket's
    // catch, which answers at the DM root where this reply is not.
    deps.log(`run failed: ${String(error)}`);
    // A stored pick the agent's roster dropped would repeat forever otherwise:
    // nothing that fails a turn can offer the picker that would fix it. Matched
    // on each failure's exact shape, since "agent X not offered" is a different
    // refusal from either of these.
    const failed = String(error);
    const staleMode = decision.mode !== undefined && /: mode \S+ not offered \(/.test(failed);
    const staleModel =
      decision.model !== undefined && /: model "[^"]+" is not offered by the agent/.test(failed);
    const unoffered = staleMode || staleModel;
    // Tracked, not assumed: a clear that failed leaves the stale mode in
    // place, and claiming recovery would promise a retry that fails the same
    // way. Fail-open on the write itself — the turn's outcome stands either way.
    // Whichever drifted is what the member is told about, and what gets cleared.
    const dropped = staleMode ? decision.mode : decision.model;
    const shed =
      unoffered &&
      (await (staleMode ? deps.shedMode : deps.shedModel)(conversation.id).then(
        () => true,
        () => false,
      ));
    try {
      await deps.finish(conversation.id, turn, 'failed');
      await deps.mark(message.channel, message.ts, 'failed');
      await deps.post(
        conversation.dmChannel,
        unoffered
          ? shed
            ? `The agent no longer offers \`${dropped}\`, so I cleared it. Send it again and I will retry with its default.`
            : `The agent no longer offers \`${dropped}\`, and I could not clear it. Send it again and I will keep trying.`
          : 'That run did not finish. Send it again and I will retry.',
        conversation.rootThread,
        undefined,
        // The acknowledgement named the files it fetched, and a turn that never
        // reached the agent leaves that promise standing — so what could not be
        // read is said here too, where the member is deciding whether to resend.
        skippedNote(attached),
      );
    } finally {
      // Or "Reading `rows.csv`…" is left standing over "That run did not
      // finish" — and a card still spinning would claim the opposite of what
      // it sits over. In a `finally` because everything above can throw too,
      // and whatever the member does see, the narration must not outlive it.
      await settle(opening, 'error');
    }
    return 'failed';
  }

  const ran = {
    session: answer.session,
    endpoint: decision.endpoint,
    agent: decision.agent,
    ...(decision.workspace ? { workspace: decision.workspace } : {}),
  };
  // §5: the answer is a private draft, and the button is the only way it leaves.
  // Nowhere to go back to means no button, rather than one that would refuse
  // itself when pressed.
  try {
    const to = await deps.destination(conversation.id);
    // Slack refuses an empty message, so a quiet run would be reported as failed.
    await deps.post(
      conversation.dmChannel,
      answer.text.trim() || 'That finished without producing an answer.',
      conversation.rootThread,
      to ? { conversation: conversation.id, destination: `<#${to.channel}>` } : undefined,
      // The handoff back to the terminal, as an aside rather than in the answer:
      // the session the turn ran in is listed by the agent's own CLI, and this
      // is the one line that turns "it ran somewhere" into somewhere reachable.
      [
        // First among the asides: it reframes everything under it — a partial
        // answer read as complete is the misreport, not the stop itself.
        ...(stopped ? ['Stopped at your request — this is where it got to.'] : []),
        ...answer.notices,
        ...skippedNote(attached),
        // The agent took the turn but not the file: said here because the
        // acknowledgement already promised the member it was being read.
        ...unsupportedNote(decision.agent, answer.unsupported),
        ...approvalNote(answer.approvals),
        ...(spent(answer.models?.currentModelId, answer.usage) ?? []),
        // Said, not just shown: a bare `codex resume <id>` under an answer reads
        // as a claim that the turn resumed something, which on a fresh session
        // is exactly backwards. It is an offer — the same session, open in their
        // own terminal — and four words is the difference.
        //
        // The command is a closed set at the parse boundary; the session id is
        // the agent's own string and is not. A mismatch is the agent having
        // minted a fresh session rather than taking the one offered, which is
        // the only time this thread has an id it was not already given. Same
        // test the driver sends the transcript on.
        ...(answer.resumeWith && answer.session !== decision.resume
          ? [`Yours in the terminal too: \`${answer.resumeWith} ${plainly(answer.session)}\``]
          : []),
      ],
      // The picker renders the agent's own roster, so it exists exactly where
      // the agent serves one — and only inside a named workspace, the one
      // place a mode means anything (§4).
      // Both rosters ride the answer, but a mode only means something inside a
      // named workspace — where the model is a preference anywhere. Nothing to
      // render means no payload at all, rather than a conversation id with no
      // picker to carry.
      pickers(conversation.id, decision.agent, answer, decision.workspace !== undefined),
    );
  } catch (error) {
    // The run is over either way, and `announcing` tells them the delivery
    // failed. Leaving the mark saying it is still going would outlive that
    // message and be the last thing they are told.
    await deps.mark(message.channel, message.ts, 'failed');
    await deps.finish(conversation.id, turn, 'completed', ran);
    // Like the mark above it: an acknowledgement still saying it is working
    // would outlive the message that never arrived.
    await settle(restingFor(answer.session));
    throw error;
  }
  await deps.mark(message.channel, message.ts, 'done');
  // Before the turn is closed, which is what lets the next one start: the cursor
  // is what that turn filters its read by, so a thread released with it still
  // behind this answer catches the next one up on what this one already covered.
  // Fail-open all the same — a cursor that did not move costs a re-read, where
  // failing a delivered turn costs the answer.
  if (caught?.seenThrough)
    await deps.seen(conversation.id, caught.seenThrough).catch((error: unknown) => {
      deps.log(`cursor not moved: ${String(error)}`);
    });
  await deps.finish(conversation.id, turn, 'completed', ran);
  await settle(restingFor(answer.session));
  return existing ? 'resumed' : 'opened';
}
