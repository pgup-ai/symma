/** Ids that appear in URLs, filenames and control messages. Shared by the
 * relay, the journal and every client, so it lives with the protocol. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id);
}

/** Model ids need a wider alphabet than the rest: agents publish them with the
 * reasoning effort bracketed in (codex-acp's `gpt-5.6-sol[high]`) and with
 * vendor prefixes (`kilo/vendor/model`). Still bounded, and still never a path
 * or a filename — a model id only ever rides a control message and a child's
 * environment. */
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._[\]/-]{0,127}$/;

export function isSafeModelId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_MODEL_ID.test(id);
}
