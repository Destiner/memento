import type {
  ActualMemoryOperation,
  HistoryClient,
  NormalizedEvent,
  NormalizedThread,
  ProjectContext,
  ProjectResolutionHints,
} from '../model.js';

export interface ParseHistoryOptions {
  sourceId: string;
  sourcePathHint?: string;
}

export interface ParsedHistoryThread {
  client: HistoryClient;
  sourceId: string;
  rootSourceSessionId: string;
  sourceSessionId: string;
  thread: NormalizedThread;
  events: NormalizedEvent[];
  actualOperations: ActualMemoryOperation[];
  startedAt?: string;
  endedAt?: string;
  model?: string;
  clientVersion?: string;
  projectContext?: ProjectContext;
  projectResolutionHints?: ProjectResolutionHints;
  warnings: string[];
}

export class UnsupportedHistoryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedHistoryFormatError';
  }
}

export class UnsafeHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeHistoryError';
  }
}
