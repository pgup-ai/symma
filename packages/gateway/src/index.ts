// The gateway is an application (`server.ts` is the entry). This surface is the
// operator seam: provisioning, pairing, and the two lifecycle operations §1
// promises, none of which have a route because their trigger is a Slack event
// that arrives with M3d. An operator runs them against the same database.
// `deleteJournals` travels with them: both return the sessions they removed and
// nothing else, so an operator who keeps only the rows leaves frames on disk
// that retention can no longer reach.
export { deleteJournals, readJournalLines } from './journal.js';
export {
  openStore,
  provision,
  type Owner,
  type PairingResult,
  type SessionRef,
  type Store,
} from './store.js';
