export const NORMALIZED_SCHEMA_VERSION = 1 as const;

export type NormalizedSchemaVersion = typeof NORMALIZED_SCHEMA_VERSION;
export type HistoryClient = 'claude-code' | 'codex';
export type PolicyVersion = string | 'unknown';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProjectContext {
  workingDirectory?: string;
  workingDirectoryName?: string;
  gitRemote?: string;
  repositorySlug?: string;
  projectIds?: string[];
  /** At least one checkout hint could not be resolved to a canonical project id. */
  projectResolutionIncomplete?: true;
}

export interface ProjectResolutionHints {
  workingDirectory?: string;
  gitRemote?: string;
  repositorySlug?: string;
  nameHint?: string;
}

export interface NormalizedThread {
  id: string;
  sourceSessionId: string;
  parentThreadId?: string;
  agentLabel?: string;
}

export type NormalizedEventKind =
  'user_message' | 'assistant_message' | 'tool_call' | 'tool_result';

export type NormalizedEventRole = 'user' | 'assistant' | 'tool';

export interface NormalizedToolCall {
  callId: string;
  name: string;
  input?: JsonValue;
  isMemento: boolean;
}

export interface NormalizedEvent {
  schemaVersion: NormalizedSchemaVersion;
  id: string;
  sessionId: string;
  threadId: string;
  /** Stable identity shared by events emitted from one source conversation message. */
  sourceMessageId?: string;
  sequence: number;
  timestamp?: string;
  kind: NormalizedEventKind;
  role: NormalizedEventRole;
  text?: string;
  toolCall?: NormalizedToolCall;
  toolCallId?: string;
  toolOutput?: JsonValue;
  actualOperationId?: string;
}

export type CanonicalMementoTool =
  | 'resolve_project'
  | 'create_project'
  | 'update_project'
  | 'search_memories'
  | 'get_memory'
  | 'create_memory'
  | 'update_memory'
  | 'archive_memory';

export type ActualOperationKind = 'project' | 'search' | 'read' | 'write' | 'archive';
export type ActualOperationOutcome = 'unknown' | 'success' | 'error';

export interface OperationScope {
  kind: 'projects' | 'global' | 'unknown';
  projectIds?: string[];
  match?: 'any' | 'all';
}

export interface ReconciledTelemetry {
  eventId: string;
  timestamp: string;
  policyVersion?: string;
  serverVersion?: string;
  variant?: string;
  sessionId?: string;
  clientVersion?: string;
  logSchemaVersion?: number;
  outcome?: 'success' | 'error';
  resultOutcome?: string;
  resultIds?: string[];
  candidateIds?: string[];
  memoryId?: string;
  projectIds?: string[];
}

export interface ActualMemoryOperation {
  schemaVersion: NormalizedSchemaVersion;
  id: string;
  sessionId: string;
  threadId: string;
  callEventId: string;
  resultEventId?: string;
  sequence: number;
  timestamp?: string;
  completedAt?: string;
  tool: CanonicalMementoTool;
  kind: ActualOperationKind;
  sourceToolName: string;
  callId: string;
  input?: JsonValue;
  output?: JsonValue;
  outcome: ActualOperationOutcome;
  scope?: OperationScope;
  memoryIds?: string[];
  telemetry?: ReconciledTelemetry;
}

export type ActualOperation = ActualMemoryOperation;

export interface NormalizedSession {
  schemaVersion: NormalizedSchemaVersion;
  id: string;
  client: HistoryClient;
  sourceSessionIds: string[];
  sourceIds: string[];
  rootThreadId: string;
  threads: NormalizedThread[];
  events: NormalizedEvent[];
  actualOperations: ActualMemoryOperation[];
  startedAt?: string;
  endedAt?: string;
  model?: string;
  clientVersion?: string;
  policyVersion: PolicyVersion;
  projectContext?: ProjectContext;
  warnings: string[];
}

export interface QuarantinedSource {
  sourceId: string;
  client?: HistoryClient;
  reason: string;
}

export interface InternalSourceReference {
  sourceId: string;
  client: HistoryClient;
  path: string;
  contentSha256: string;
}

export interface IngestionResult {
  sessions: NormalizedSession[];
  sources: InternalSourceReference[];
  projectResolutionHints: Record<string, ProjectResolutionHints[]>;
  quarantined: QuarantinedSource[];
  warnings: string[];
}
