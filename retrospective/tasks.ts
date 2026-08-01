import {
  NORMALIZED_SCHEMA_VERSION,
  type ActualOperation,
  type HistoryClient,
  type NormalizedEvent,
  type NormalizedSession,
  type PolicyVersion,
  type ProjectContext,
} from './model.js';

export interface NormalizedTask {
  schemaVersion: typeof NORMALIZED_SCHEMA_VERSION;
  id: string;
  sessionId: string;
  index: number;
  rootUserEventId: string;
  client: HistoryClient;
  model?: string;
  clientVersion?: string;
  policyVersion: PolicyVersion;
  projectContext?: ProjectContext;
  startSequence: number;
  endSequence: number;
  startedAt?: string;
  endedAt?: string;
  events: NormalizedEvent[];
  actualOperations: ActualOperation[];
}

export function splitTasks(session: NormalizedSession): NormalizedTask[] {
  const events = [...session.events].sort(compareSequence);
  const starts = events.filter(
    (event) => event.kind === 'user_message' && event.threadId === session.rootThreadId,
  );

  return starts.map((start, index) => {
    const next = starts[index + 1];
    const taskEvents = events.filter(
      (event) =>
        event.sequence >= start.sequence && (next === undefined || event.sequence < next.sequence),
    );
    const last = taskEvents.at(-1) ?? start;
    const actualOperations = session.actualOperations
      .filter(
        (operation) =>
          operation.sequence >= start.sequence &&
          (next === undefined || operation.sequence < next.sequence),
      )
      .sort(compareSequence);

    return {
      schemaVersion: NORMALIZED_SCHEMA_VERSION,
      id: `${session.id}:task:${start.id}`,
      sessionId: session.id,
      index,
      rootUserEventId: start.id,
      client: session.client,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.clientVersion === undefined ? {} : { clientVersion: session.clientVersion }),
      policyVersion: session.policyVersion,
      ...(session.projectContext === undefined ? {} : { projectContext: session.projectContext }),
      startSequence: start.sequence,
      endSequence: last.sequence,
      ...(start.timestamp === undefined ? {} : { startedAt: start.timestamp }),
      ...(last.timestamp === undefined ? {} : { endedAt: last.timestamp }),
      events: taskEvents,
      actualOperations,
    };
  });
}

function compareSequence(
  left: { sequence: number; id: string },
  right: { sequence: number; id: string },
): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}
