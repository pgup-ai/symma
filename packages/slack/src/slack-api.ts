/**
 * The Slack Web API calls the conversation paths need.
 *
 * `@slack/web-api` carries what this layer would otherwise owe Slack itself:
 * pagination cursors, `ok: false` on a 200, a typed error holding Slack's own
 * code, and `Retry-After` on a 429.
 */
import { ErrorCode, WebClient, type SectionBlock, type WebAPIPlatformError } from '@slack/web-api';

import { isSafeId, isSafeModelId, type SessionModels, type SessionModes } from '@symma/protocol';

import type { FetchedFile } from './attachments.js';
import { UNKNOWN_AUTHOR, type ThreadMessage } from './snapshot.js';

export interface SlackApi {
  /** Oldest first. Undefined when the bot cannot see the channel at all, which
   * §4 wants said out loud rather than answered around. */
  threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
  /** The member's DM channel. Asked for rather than assumed: Slack's docs
   * disagree about whether a user id can stand in as a channel. */
  openDm: (user: string) => Promise<string>;
  /** A link back to a message, so a conversation lifted out of a channel says
   * which thread it came from. Undefined rather than throwing: a handoff without
   * its link is worth having, and one that refused to happen is not. */
  permalink: (channel: string, ts: string) => Promise<string | undefined>;
  post: (
    channel: string,
    text: string,
    threadTs?: string,
    /** §5's action on a finished answer. The button carries the conversation and
     * nothing else — where it may publish is the gateway's to state. */
    offerShare?: { conversation: string; destination: string },
    /** The agent talking about itself rather than answering. Rendered as a
     * context block, which is Slack's own small-and-grey — the member should be
     * able to tell it from the answer without reading it. */
    notices?: string[],
    /** §4's pickers, rendered from the agent's own rosters. A selection carries
     * the conversation and the chosen id; what to do with them is the gateway's
     * to decide, same as the share button. */
    pickers?: {
      conversation: string;
      /** Whose rosters these are — a model id is only meaningful under it. */
      agent: string;
      modes?: SessionModes;
      models?: SessionModels;
    },
  ) => Promise<{ channel: string; ts: string }>;
  /** Rewrites the acknowledgement while a run is out, so a long turn can show
   * what the agent is doing. Never throws, and carries no blocks of its own: a
   * progress line that failed to land must not cost the answer behind it. */
  working: (channel: string, ts: string, text: string) => Promise<void>;
  /** Rewrites a posted message without its actions, so a share cannot be
   * pressed twice. Never throws: the publication has already landed by then,
   * and reporting a failed update as a failed share would be a lie the member
   * acts on. Any notices go with the rewrite — deliberately: they are an aside
   * on a message that has been read and acted on, and carrying them would mean
   * widening this and `share` to hold text neither publishes. */
  settle: (channel: string, ts: string, text: string) => Promise<void>;
  /** 👀 on the member's own message while the run is out, replaced when it
   * lands. Never throws: the mark is a hint, and losing one must not cost them
   * the answer it was a hint about. */
  mark: (channel: string, ts: string, state: MarkState) => Promise<void>;
  /** Downloads one of Slack's own file URLs. `url_private_download` is not a
   * public link — it needs the bot token as a bearer header, which is why this
   * lives here and not in whatever wants the bytes. */
  fetchFile: (url: string, maxBytes: number) => Promise<FetchedFile>;
  /** The app's home tab. Republished on every open, because it renders gateway
   * state and nothing else would ever tell it to refresh. */
  publishHome: (user: string, blocks: Record<string, unknown>[]) => Promise<void>;
  /** Publishes into the source thread. Returns why it could not rather than
   * throwing: §5 keeps the answer in the DM and names which of these happened,
   * and a publication that cannot land is not a lost answer. */
  share: (
    channel: string,
    thread: string,
    text: string,
    /** The member's own Slack token. Slack decides authorship by token type, so
     * this is the whole difference between posting as them and posting as the
     * bot with their name typed in front. */
    asMember?: string,
  ) => Promise<{ ok: true } | { ok: false; why: Unusable }>;
}

/** The ways a destination stops being one, as §5 lists them — plus `author`,
 * which is not about the destination at all: the member's own token has stopped
 * working, and the same post as the bot would land. */
export type Unusable = 'archived' | 'removed' | 'locked' | 'gone' | 'scope' | 'author';

/** A run takes minutes, and Slack offers no way to say so in the composer — so
 * the member's own message carries it. */
export type MarkState = 'working' | 'done' | 'failed';

const MARK: Record<MarkState, string> = {
  working: 'eyes',
  done: 'white_check_mark',
  failed: 'x',
};

/** Slack's names for a token it will not honour any more: revoked from the
 * member's side, or an app whose install was replaced. */
const DEAD_TOKEN = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed']);

const UNUSABLE: Record<string, Unusable> = {
  is_archived: 'archived',
  not_in_channel: 'removed',
  channel_not_found: 'gone',
  thread_not_found: 'gone',
  restricted_action: 'locked',
  restricted_action_read_only_channel: 'locked',
  missing_scope: 'scope',
};

/** Threads cap far below this in practice; it is here so a pathological one
 * cannot spin the fetch loop, not as a limit anybody should reach. */
const MAX_PAGES = 20;

/** Slack's own caps on a message. Exceeding either block one is a rejected post,
 * and a rejected post turns a finished run into a reported failure — which is
 * how an answer gets lost rather than merely mis-rendered. */
const BLOCK_TEXT_LIMIT = 3000;
const MESSAGE_BLOCK_LIMIT = 50;
const FALLBACK_TEXT_LIMIT = 40_000;

/** A file download is a CDN fetch, not an API call — bounded on its own because
 * a stalled one would otherwise hold the whole turn. */
const FILE_FETCH_TIMEOUT_MS = 20_000;

/** Five-second client for idempotent, non-answer hints. `postMessage` keeps the
 * SDK defaults to avoid duplicating an accepted answer; `settle` keeps them
 * because losing that update leaves the share button active. */
const ASIDE_TIMEOUT_MS = 5_000;

/** A name or a title the member or their agent chose, on its way into mrkdwn:
 * a backtick would open a code span that swallows the rest of the sentence, and
 * a newline would break the block it sits in. */
export const plainly = (text: string): string =>
  text
    // Slack's three mrkdwn entities, ampersand first or the escapes double up.
    // `<!channel>` in a filename would otherwise broadcast when an answer is
    // shared, and `<http://x|y>` would render as a link nobody wrote.
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/[`\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Cut to `limit` and say so, so what is missing is visible rather than a
 * sentence that stops. */
const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, cut(text, limit - 1))}…` : text;

/** Slack counts its limits in characters, where JS slices in UTF-16 units — so
 * a cut landing between the halves of an emoji leaves a lone surrogate that
 * renders as a replacement glyph. One unit back is always a whole character. */
const cut = (text: string, at: number): number =>
  /[\uD800-\uDBFF]/.test(text[at - 1]!) ? at - 1 : at;

/** The answer as however many sections it needs, split at a line break near the
 * limit where there is one. */
function sections(text: string, budget: number): SectionBlock[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > BLOCK_TEXT_LIMIT && parts.length < budget - 1) {
    // Short of the limit, because the closing fence below has to fit as well.
    const room = BLOCK_TEXT_LIMIT - 4;
    const line = rest.lastIndexOf('\n', room);
    // Only when what is left still fits without it: a tidy break is worth less
    // than the tail it would cost, since the blocks that remain are counted.
    const fits = rest.length - line <= (budget - parts.length - 1) * room;
    const at = line > room / 2 && fits ? line : cut(rest, room);
    let part = rest.slice(0, at);
    rest = rest.slice(at);
    // A cut inside a fence leaves it open, so this section swallows the rest of
    // itself as code and the next starts with a stray close. Shut here and
    // reopened there, in the language it was opened with.
    const fences = part.match(/^```.*$/gm) ?? [];
    if (fences.length % 2) {
      part += '\n```';
      rest = `${fences[fences.length - 1]!}\n${rest}`;
    }
    parts.push(part);
  }
  // Only reachable on an answer past the whole message's budget, where the
  // choice is a truncated one or none at all.
  parts.push(clip(rest, BLOCK_TEXT_LIMIT));
  return parts.map((part) => ({ type: 'section', text: { type: 'mrkdwn', text: part } }));
}

/** The one action id the bot listens for, shared by the button and its handler. */
export const SHARE_ACTION = 'share_to_thread';

/** The picker action ids, shared with their handlers. */
export const MODE_ACTION = 'set_conversation_mode';
export const MODEL_ACTION = 'set_conversation_model';
/** A model pick with no conversation under it: `/model` and the home tab, which
 * set what the member's *next* conversation starts on. */
export const DEFAULT_MODEL_ACTION = 'set_default_model';
/** Which of their machine's agents a member works with. The home tab only —
 * it is a choice about the machine, not about a thread. */
export const DEFAULT_AGENT_ACTION = 'set_default_agent';

/** Slack's static_select caps: options per select, characters per value. */
const PICKER_OPTION_LIMIT = 100;
const PICKER_VALUE_LIMIT = 150;

/** One roster entry as the picker shows it and hands it back. `initial_option`
 * must deep-equal one of `options` for Slack to accept it, so both are built
 * here and nowhere else. */
const pickerOption = (
  /** Absent where the pick belongs to the member rather than to one thread —
   * `/model` and the home tab, which have no conversation to name. */
  conversation: string | undefined,
  id: string,
  label: string,
  about?: string,
  agent?: string,
) => ({
  // Slack caps both of these at 75 characters.
  text: { type: 'plain_text' as const, text: label.slice(0, 75) },
  ...(about ? { description: { type: 'plain_text' as const, text: about.slice(0, 75) } } : {}),
  // `a` is whose roster this came from — a model id means nothing under another
  // agent, so the selection carries where it was offered.
  value: JSON.stringify({
    ...(conversation ? { c: conversation } : {}),
    m: id,
    ...(agent ? { a: agent } : {}),
  }),
});

/** A select, bounded to what Slack will post and what can round-trip: an id
 * outside its wire alphabet, or a value past Slack's cap, could be shown but
 * never selected — and one roster past the option cap would cost the whole
 * answer it rides on. A current choice the bounds dropped just loses its
 * highlight; the placeholder stands in. */
function rosterSelect(
  conversation: string | undefined,
  action: string,
  placeholder: string,
  entries: { id: string; label: string; about?: string; safe: boolean }[],
  currentId: string | undefined,
  agent?: string,
): Record<string, unknown>[] {
  const option = (entry: { id: string; label: string; about?: string }) =>
    pickerOption(conversation, entry.id, entry.label, entry.about, agent);
  const options = entries
    .filter((entry) => entry.safe)
    .map(option)
    .filter((value) => value.value.length <= PICKER_VALUE_LIMIT)
    .slice(0, PICKER_OPTION_LIMIT);
  if (!options.length) return [];
  const current = entries.find((entry) => entry.id === currentId);
  const initial = current && option(current);
  return [
    {
      type: 'static_select',
      action_id: action,
      placeholder: { type: 'plain_text', text: placeholder },
      options,
      ...(initial && options.some((option) => option.value === initial.value)
        ? { initial_option: initial }
        : {}),
    },
  ];
}

const modeSelect = (conversation: string, modes: SessionModes): Record<string, unknown>[] =>
  rosterSelect(
    conversation,
    MODE_ACTION,
    'Session mode',
    modes.availableModes.map((mode) => ({
      id: mode.id,
      label: mode.name ?? mode.id,
      // The agent's own sentence about what the choice means — codex writes
      // "Read and edit files, and run commands." for `agent`.
      ...(mode.description ? { about: mode.description } : {}),
      safe: isSafeId(mode.id),
    })),
    modes.currentModeId,
  );

export const modelSelect = (
  conversation: string | undefined,
  models: SessionModels,
  agent: string,
): Record<string, unknown>[] =>
  // A model pick is stored against the agent that offered it, and the gateway
  // takes an agent name only in the wire's alphabet — a custom `name=cmd` entry
  // can be called anything. No picker beats one whose every selection 400s.
  !isSafeId(agent)
    ? []
    : rosterSelect(
        conversation,
        conversation ? MODEL_ACTION : DEFAULT_MODEL_ACTION,
        'Model',
        models.availableModels.map((model) => ({
          id: model.modelId,
          label: model.name ?? model.modelId,
          ...(model.description ? { about: model.description } : {}),
          // Model ids carry a bracketed reasoning effort, so they need the wider
          // alphabet — the same one the gateway's route accepts.
          safe: isSafeModelId(model.modelId),
        })),
        models.currentModelId,
        agent,
      );

/** The agents this machine is logged into: names the companion resolved, not a
 * roster with descriptions. One outside the wire's alphabet is dropped rather
 * than shown, since the gateway would refuse the pick it produced. */
export const agentSelect = (agents: string[], current: string): Record<string, unknown>[] =>
  rosterSelect(
    undefined,
    DEFAULT_AGENT_ACTION,
    'Agent',
    agents.map((agent) => ({ id: agent, label: agent, safe: isSafeId(agent) })),
    current,
  );

/** Slack codes that mean "not visible to this bot" rather than "broken". Anything
 * else throws: guessing which is which is how a partial snapshot gets answered. */
const UNREADABLE = new Set(['not_in_channel', 'channel_not_found', 'missing_scope']);

/** Read off the typed error, never off a message — the code is the fact, and a
 * message is prose a version can reword. */
const slackCode = (error: unknown): string | undefined =>
  (error as { code?: string }).code === ErrorCode.PlatformError
    ? (error as WebAPIPlatformError).data.error
    : undefined;

interface RawMessage {
  ts?: unknown;
  user?: unknown;
  text?: unknown;
  files?: { name?: unknown; size?: unknown }[];
}

const read = (raw: RawMessage[], names: Map<string, string>): ThreadMessage[] =>
  raw
    .filter((m): m is RawMessage & { ts: string } => typeof m.ts === 'string')
    .map((m) => ({
      ts: m.ts,
      // Slack's own messages — a join, a bot post — carry no `user`, and so are
      // never asked about. The rest are always in the map: `threadReplies` builds
      // it from these same messages by this same test.
      author: typeof m.user === 'string' ? names.get(m.user)! : UNKNOWN_AUTHOR,
      text: typeof m.text === 'string' ? m.text : '',
      // Named, never fetched: downloading widens both the scope request and the
      // data-lifecycle surface (§10).
      ...(m.files?.length
        ? {
            files: m.files.map((f) => ({
              name: typeof f.name === 'string' ? f.name : 'file',
              ...(typeof f.size === 'number' ? { size: f.size } : {}),
            })),
          }
        : {}),
    }));

/** `fetch` is injectable so a test can answer without a live workspace; the
 * default client keeps the SDK's own retry, which is what handles a 429. */
export function slackApi(
  token: string,
  options: { fetch?: typeof fetch; log?: (message: string) => void } = {},
): SlackApi {
  const client = new WebClient(token, options.fetch ? { fetch: options.fetch } : {});
  const quick = new WebClient(token, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeout: ASIDE_TIMEOUT_MS,
    retryConfig: { retries: 1 },
  });

  /** Looked up rather than left as `<@U…>`, which Slack would render for free:
   * the agent reads this text back as its only record of a channel it cannot see,
   * so an id there is unreadable to it as well as to the member. Cached for the
   * process — a thread is a few people saying many things, and a display name
   * changes about as often as a bot restarts. */
  const cache = new Map<string, string>();
  const nameOf = async (id: string): Promise<string> => {
    const known = cache.get(id);
    if (known) return known;
    const name = await quick.users
      .info({ user: id })
      .then((got) => {
        const profile = got.user?.profile;
        return profile?.display_name || profile?.real_name || got.user?.name;
      })
      .catch(() => undefined);
    // Only what resolved is kept. A missing scope or a rate limit would otherwise
    // pin every name in the process to its fallback until a restart — including
    // across the reinstall that granted the scope.
    if (!name) return `<@${id}>`;
    // Escaped like every other name this bot renders — a display name is whatever
    // its owner typed, and it lands inside `*bold*` in a quote — and back to the
    // mention if escaping leaves nothing of it.
    const resolved = plainly(name) || `<@${id}>`;
    cache.set(id, resolved);
    return resolved;
  };

  return {
    async threadReplies(channel, thread) {
      try {
        const raw: RawMessage[] = [];
        let pages = 0;
        // Paged to the end, because `conversations.replies` returns the oldest
        // replies first: stopping at one page and advancing the cursor to its
        // newest would put every later page permanently behind it.
        for await (const page of client.paginate('conversations.replies', {
          channel,
          ts: thread,
          limit: 200,
        })) {
          // Refused rather than truncated, for the same reason: what a cap drops
          // is the newest end, the part the question is most likely about.
          if (++pages > MAX_PAGES) throw new Error('thread too long to read');
          raw.push(...((page as { messages?: RawMessage[] }).messages ?? []));
        }
        const ids = new Set(raw.flatMap((m) => (typeof m.user === 'string' ? [m.user] : [])));
        const names = new Map(
          await Promise.all(
            [...ids].map(async (id): Promise<[string, string]> => [id, await nameOf(id)]),
          ),
        );
        return read(raw, names);
      } catch (error) {
        const code = slackCode(error);
        if (code && UNREADABLE.has(code)) return undefined;
        throw error;
      }
    },
    permalink(channel, ts) {
      return quick.chat
        .getPermalink({ channel, message_ts: ts })
        .then((got) => (typeof got.permalink === 'string' ? got.permalink : undefined))
        .catch(() => undefined);
    },
    async openDm(user) {
      const { channel } = await client.conversations.open({ users: user });
      if (!channel?.id) throw new Error('conversations.open returned no channel');
      return channel.id;
    },
    async post(channel, text, threadTs, offerShare, notices, pickers) {
      const elements = [
        ...(offerShare
          ? [
              {
                type: 'button',
                action_id: SHARE_ACTION,
                text: { type: 'plain_text', text: 'Share to thread' },
                value: offerShare.conversation,
                // §5 wants the destination previewed before it is published,
                // and the content is the message this sits on.
                confirm: {
                  title: { type: 'plain_text', text: 'Share this answer?' },
                  text: {
                    type: 'mrkdwn',
                    text: `It will be posted to ${offerShare.destination}, with your name on it.`,
                  },
                  confirm: { type: 'plain_text', text: 'Share' },
                  deny: { type: 'plain_text', text: 'Keep private' },
                },
              },
            ]
          : []),
        ...(pickers?.modes ? modeSelect(pickers.conversation, pickers.modes) : []),
        ...(pickers?.models
          ? modelSelect(pickers.conversation, pickers.models, pickers.agent)
          : []),
      ];
      const actions = elements.length ? [{ type: 'actions', elements }] : [];
      // The answer takes the blocks it needs and the asides take what is left,
      // in that order — a run that talked about itself a lot must not crowd out
      // what it was talking alongside. One block is held back for them all the
      // same: an aside gone without trace is worse than an answer a block
      // shorter, since it is often the part saying something went wrong.
      const room = MESSAGE_BLOCK_LIMIT - actions.length;
      const body = sections(text, room - (notices?.length ? 1 : 0));
      const shown = (notices ?? []).slice(0, room - body.length);
      const hidden = (notices?.length ?? 0) - shown.length;
      // Above the answer, which is where the agent put it. Truncated rather
      // than dropped: one over the limit would take the whole post down with it.
      const context = shown.map((notice, index) => ({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              hidden && index === shown.length - 1
                ? `${clip(notice, BLOCK_TEXT_LIMIT - 40)}\n_and ${String(hidden)} more_`
                : clip(notice, BLOCK_TEXT_LIMIT),
          },
        ],
      }));
      const sent = await client.chat.postMessage({
        channel,
        // Sent alongside the blocks as the notification and accessibility text,
        // which Slack uses wherever it will not render them. Bounded here for
        // the same reason the blocks are: what Slack does past its own limit is
        // not worth finding out on a member's answer.
        text: clip(text, FALLBACK_TEXT_LIMIT),
        ...(threadTs ? { thread_ts: threadTs } : {}),
        // Blocks replace the body wholesale, so the answer's own section has to
        // be rebuilt here as soon as anything needs to go with it — and a plain
        // body has no length limit worth reaching where a section does.
        // An answer past one section needs them too, or the plain body is all
        // that carries it and everything past the fallback's own cap is gone.
        ...(context.length || actions.length || body.length > 1
          ? { blocks: [...context, ...body, ...actions] }
          : {}),
      });
      if (!sent.channel || !sent.ts) throw new Error('chat.postMessage returned no message');
      return { channel: sent.channel, ts: sent.ts };
    },
    async working(channel, ts, text) {
      try {
        await quick.chat.update({ channel, ts, text: clip(text, FALLBACK_TEXT_LIMIT) });
      } catch (error) {
        // Said once rather than swallowed: a scope or rate-limit problem here
        // is invisible otherwise, and the answer still arrives either way. The
        // logger is a caller's callback, so it gets `mark`'s treatment too.
        try {
          options.log?.(`progress update failed: ${slackCode(error) ?? String(error)}`);
        } catch {
          /* a caller's logger is not worth the turn either */
        }
      }
    },
    async fetchFile(url, maxBytes) {
      // The SDK covers `api.slack.com` calls; a file URL is plain HTTP with the
      // same token, so it goes through fetch directly.
      const res = await (options.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, status: res.status };
      if (!res.body) return { ok: true, bytes: Buffer.alloc(0) };
      // Counted as it arrives rather than measured after: a response without a
      // `content-length` — or one that under-reports — would otherwise be
      // buffered whole before anything could refuse it, and these are files a
      // member uploaded, at whatever size they liked.
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let read = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        read += value.byteLength;
        if (read > maxBytes) {
          void reader.cancel().catch(() => undefined);
          return { ok: false, status: 413, pulled: read };
        }
        chunks.push(Buffer.from(value));
      }
      return { ok: true, bytes: Buffer.concat(chunks) };
    },
    async settle(channel, ts, text) {
      try {
        await client.chat.update({
          channel,
          ts,
          text: clip(text, FALLBACK_TEXT_LIMIT),
          blocks: sections(text, MESSAGE_BLOCK_LIMIT),
        });
      } catch {
        /* the share landed; the button outliving it is the smaller problem */
      }
    },
    async publishHome(user, blocks) {
      // Through `apiCall` rather than the typed `views.publish`: that one wants
      // the SDK's own block union, and every block this file builds is the loose
      // shape `chat.postMessage` takes. Same client, same retries, no cast.
      await quick.apiCall('views.publish', { user_id: user, view: { type: 'home', blocks } });
    },
    async mark(channel, ts, state) {
      // Losing a mark must not cost the answer it hints at — but a scope that
      // was never granted loses every one, and silence left nothing to find
      // that with.
      const swallow = (what: string) => (error: unknown) => {
        try {
          options.log?.(`${what}: ${String(error)}`);
        } catch {
          /* a caller's logger is not worth the turn either */
        }
      };
      // Swallowed one call at a time rather than around the pair: a working
      // mark that is not there is ordinary — its own add may have failed — and
      // must not stop the one that replaces it.
      if (state !== 'working') {
        await quick.reactions
          .remove({ channel, timestamp: ts, name: MARK.working })
          .catch(swallow('unmarking working'));
      }
      await quick.reactions
        .add({ channel, timestamp: ts, name: MARK[state] })
        .catch(swallow(`marking ${state}`));
    },
    async share(channel, thread, text, asMember) {
      try {
        // Built per call: a client cached across members posts as the wrong one.
        const author = asMember
          ? new WebClient(asMember, options.fetch ? { fetch: options.fetch } : {})
          : client;
        await author.chat.postMessage({ channel, text, thread_ts: thread });
        return { ok: true };
      } catch (error) {
        const code = slackCode(error) ?? '';
        // A member's token Slack has stopped honouring is not a broken bot and
        // not a bad destination: the answer can still go, just not as them.
        if (asMember && DEAD_TOKEN.has(code)) return { ok: false, why: 'author' };
        const why = UNUSABLE[code];
        // Only the ways a destination goes bad are answers. Anything else is
        // this bot being broken, which the caller reports as a failure.
        if (!why) throw error;
        return { ok: false, why };
      }
    },
  };
}
