/** Ids that appear in URLs, filenames and control messages. Shared by the
 * relay, the journal and every client, so it lives with the protocol. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id);
}
