// The package's whole public surface. Anything a consumer needs must be listed
// here — a symbol exported from its module but missing from this file is
// unreachable through the package, however public it looks in source.
export {
  CODEX_ACP_BIN,
  codexAcpSpec,
  createNdjsonReader,
  cursorAcpSpec,
  devinAcpSpec,
  driveAcpSession,
  kiloAcpSpec,
  matchModelOptionValue,
  respondToPermissionRequest,
  type AcpAgentSpec,
} from './acp-protocol.js';

export {
  spawnWithTimeout,
  terminateProcessTree,
  type CliProcessOptions,
  type CliProcessResult,
} from './cli-process.js';

export {
  CODEX_PROVIDER_ID,
  codexAuthPath,
  codexEnvForHome,
  isCodexProvider,
  writeCodexAuth,
} from './codex.js';

export {
  CURSOR_CLI_BIN,
  CURSOR_PROVIDER_ID,
  cursorEnvForKey,
  isCursorProvider,
  listCursorModels,
  parseCursorModelList,
} from './cursor.js';

export {
  buildDevinReadOnlyConfig,
  DEVIN_CLI_BIN,
  DEVIN_PROVIDER_ID,
  devinCredentialsPath,
  isDevinProvider,
  writeDevinCredentials,
  type DevinCliConfig,
} from './devin.js';

export {
  assertValidKiloAuth,
  isKiloProvider,
  KILO_CLI_BIN,
  KILO_PROVIDER_ID,
  KILO_STRIPPED_ENV_KEYS,
  kiloEnvForAuth,
  listKiloModels,
  parseKiloModelList,
} from './kilo.js';

export {
  generateSigningKeys,
  publicKeyFrom,
  signEnvelope,
  verifyEnvelope,
  verifyJournalLines,
} from './envelope-signature.js';

export { parseEnvelope, type ObserverEnvelope } from './envelope.js';
export { readNdjsonBody } from './ndjson.js';
export { isSafeId } from './ids.js';
export { parseModelName, type ParsedModel } from './model.js';
export { truncateForLog } from './text.js';
export { onFatalSignal } from './signal-cleanup.js';

export {
  parseRelayControl,
  type AckControl,
  type CloseControl,
  type EndpointAgent,
  type EndpointPresence,
  type HelloControl,
  type OpenControl,
  type RelayControl,
  type SendLine,
} from './relay-control.js';
