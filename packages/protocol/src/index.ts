// The package's whole public surface, by module then name. A type that appears
// in an exported signature is exported too, so a consumer can name it.
export {
  CODEX_ACP_BIN,
  claudeAcpSpec,
  claudeConfigPath,
  claudeCredentialsPath,
  codexAcpSpec,
  createNdjsonReader,
  cursorAcpSpec,
  geminiAcpSpec,
  geminiOauthPath,
  devinAcpSpec,
  driveAcpSession,
  kiloAcpSpec,
  opencodeAcpSpec,
  opencodeAuthPath,
  matchModelOptionValue,
  respondToPermissionRequest,
  type AcpAgentSpec,
  type AgentOpen,
  type AcpSessionIo,
  type AcpSessionOptions,
  type AcpSessionResult,
  type ModelOptionCandidate,
  type PermissionPolicy,
  type PermissionRequestParams,
  type PermissionResponse,
  type SessionMode,
  type SessionModes,
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

export { parseEnvelope, type ObserverEnvelope } from './envelope.js';

export {
  generateSigningKeys,
  publicKeyFrom,
  signEnvelope,
  verifyEnvelope,
  verifyJournalLines,
} from './envelope-signature.js';

export { isSafeId } from './ids.js';
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

export { parseModelName, type ParsedModel } from './model.js';
export { readNdjsonBody } from './ndjson.js';

export {
  parseRelayControl,
  PROTOCOL_VERSION,
  servesProtocol,
  type AckControl,
  type CloseControl,
  type GoodbyeControl,
  type EndpointAgent,
  type EndpointPresence,
  type EndpointState,
  type EndpointWorkspace,
  type HelloControl,
  type OpenControl,
  type RefusalCode,
  type RelayControl,
  type SelectedEndpoint,
  type SendLine,
  type TurnTarget,
} from './relay-control.js';

export { onFatalSignal } from './signal-cleanup.js';
export { truncateForLog } from './text.js';
