// The gateway is an application (`server.ts` is the entry). This surface is the
// operator seam: provisioning and the two lifecycle operations §1 promises,
// which have no route because their trigger is a Slack event that arrives with
// M3d. An operator runs them against the same database until then.
export { readJournalLines } from './journal.js';
export { openStore, provision, type Owner, type SessionRef, type Store } from './store.js';
