// The gateway is an application (`server.ts` is the entry). This surface is the
// operator seam: provisioning and the two lifecycle operations §1 promises,
// which have no route because their trigger is a Slack event that arrives with
// M3d. An operator runs them against the same database until then.
// `deleteJournals` travels with them: both return the sessions they removed and
// nothing else, so an operator who keeps only the rows leaves frames on disk
// that retention can no longer reach.
export { deleteJournals, readJournalLines } from './journal.js';
// Minting is on `Store` rather than beside `provision`: pairing replaces
// provision-per-endpoint, and until §2's DM button exists an operator mints the
// code the member types. `PairingResult` comes with it because `Store` is
// exported and a consumer cannot name a redeem's result otherwise.
export {
  openStore,
  provision,
  type Owner,
  type PairingResult,
  type SessionRef,
  type Store,
} from './store.js';
