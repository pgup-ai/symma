// The gateway is an application (`server.ts` is the entry). This surface
// exists only for the companion's end-to-end test, which spawns a real gateway
// and then reads back what it journaled.
export { readJournalLines } from './journal.ts';
