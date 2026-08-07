import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { JsonValue, NormalizedSession, ProjectContext } from '../model.js';
import { stableId, stableJson } from './id.js';
import { MIGRATIONS, RETROSPECTIVE_SCHEMA_VERSION } from './schema.js';
import { COMPARISON_LABELS } from './types.js';
import type {
  CheckpointInput,
  ComparisonInput,
  EvaluatorIdentity,
  PromotionAttempt,
  PromotionStatus,
  ProposalInput,
  ReviewCommand,
  ReviewEvent,
  ReviewQueueItem,
  ReviewState,
  StoredReviewCommand,
  RunInput,
  RunRecord,
  RunStatus,
  SourceReferenceInput,
  TaskFailureInput,
  TaskFailureRecord,
  TaskInput,
} from './types.js';

export const RETROSPECTIVE_DB_FILENAME = 'evaluation.sqlite';

export interface OpenRetrospectiveStoreOptions {
  home: string;
  now?: () => Date;
}

export async function openRetrospectiveStore(
  options: OpenRetrospectiveStoreOptions,
): Promise<RetrospectiveStore> {
  const directory = join(options.home, 'retrospective');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const location = join(directory, RETROSPECTIVE_DB_FILENAME);
  const store = new RetrospectiveStore(location, options.now);
  await chmod(location, 0o600);
  return store;
}

export class RetrospectiveStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(location: string = ':memory:', now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(location);
    this.now = now;
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number | null;
    };
    return row.version ?? 0;
  }

  createRun(input: RunInput): void {
    const values = {
      id: input.id,
      source_policy_version: input.sourcePolicyVersion,
      pipeline_version: input.pipelineVersion,
      status: input.status ?? 'ingested',
      evaluator_json: input.evaluator === undefined ? null : json(input.evaluator),
      metadata_json: json(input.metadata ?? {}),
      created_at: this.timestamp(),
    };
    this.insertIdempotent(
      'runs',
      values,
      `INSERT INTO runs
        (id, source_policy_version, pipeline_version, status, evaluator_json, metadata_json, created_at)
       VALUES ($id, $source_policy_version, $pipeline_version, $status, $evaluator_json,
               $metadata_json, $created_at)`,
      ['source_policy_version', 'pipeline_version', 'evaluator_json', 'metadata_json'],
    );
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  listRuns(): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC, id')
      .all() as unknown as RunRow[];
    return rows.map(toRun);
  }

  hasTask(runId: string, taskId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS found FROM tasks WHERE run_id = ? AND id = ?')
        .get(runId, taskId) !== undefined
    );
  }

  hasTaskOutcome(runId: string, taskId: string): boolean {
    return (
      this.hasTask(runId, taskId) ||
      this.db
        .prepare('SELECT 1 AS found FROM task_failures WHERE run_id = ? AND id = ?')
        .get(runId, taskId) !== undefined
    );
  }

  recordTaskFailure(input: TaskFailureInput): void {
    const values = {
      run_id: input.runId,
      id: input.id,
      session_id: input.sessionId,
      ordinal: input.ordinal,
      start_sequence: input.startSequence,
      end_sequence: input.endSequence,
      error: input.error,
      created_at: this.timestamp(),
    };
    this.insertIdempotent(
      'task_failures',
      values,
      `INSERT INTO task_failures
        (run_id, id, session_id, ordinal, start_sequence, end_sequence, error, created_at)
       VALUES ($run_id, $id, $session_id, $ordinal, $start_sequence, $end_sequence, $error,
               $created_at)`,
      ['session_id', 'ordinal', 'start_sequence', 'end_sequence', 'error'],
      ['run_id', 'id'],
    );
  }

  listTaskFailures(runId: string): TaskFailureRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM task_failures WHERE run_id = ? ORDER BY ordinal, id')
      .all(runId) as unknown as TaskFailureRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      id: row.id,
      sessionId: row.session_id,
      ordinal: row.ordinal,
      startSequence: row.start_sequence,
      endSequence: row.end_sequence,
      error: row.error,
      createdAt: row.created_at,
    }));
  }

  setRunStatus(runId: string, status: RunStatus): void {
    const current = this.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as
      { status: RunStatus } | undefined;
    if (!current) throw new Error(`Unknown retrospective run: ${runId}`);
    const order: RunStatus[] = ['ingested', 'evaluated', 'reviewing', 'complete'];
    if (order.indexOf(status) < order.indexOf(current.status)) {
      throw new Error(`Run ${runId} cannot move from ${current.status} back to ${status}.`);
    }
    this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
  }

  ingestSourceReferences(runId: string, sources: readonly SourceReferenceInput[]): void {
    this.transaction(() => {
      this.assertExists('runs', runId);
      for (const source of sources) {
        const values = {
          run_id: runId,
          source_id: source.sourceId,
          client: source.client,
          path: source.path,
          content_sha256: source.contentSha256,
          ingested_at: this.timestamp(),
        };
        this.insertIdempotent(
          'source_references',
          values,
          `INSERT INTO source_references
            (run_id, source_id, client, path, content_sha256, ingested_at)
           VALUES ($run_id, $source_id, $client, $path, $content_sha256, $ingested_at)`,
          ['client', 'path', 'content_sha256'],
          ['run_id', 'source_id'],
        );
      }
    });
  }

  ingestSession(runId: string, session: NormalizedSession): void {
    this.transaction(() => {
      this.assertExists('runs', runId);
      const sessionValues = {
        id: session.id,
        run_id: runId,
        client: session.client,
        schema_version: session.schemaVersion,
        source_session_ids_json: json(session.sourceSessionIds),
        source_ids_json: json(session.sourceIds),
        root_thread_id: session.rootThreadId,
        started_at: session.startedAt ?? null,
        ended_at: session.endedAt ?? null,
        model: session.model ?? null,
        client_version: session.clientVersion ?? null,
        policy_version: session.policyVersion,
        project_context_json:
          session.projectContext === undefined ? null : json(session.projectContext),
        warnings_json: json(session.warnings),
      };
      this.insertIdempotent(
        'sessions',
        sessionValues,
        `INSERT INTO sessions
          (id, run_id, client, schema_version, source_session_ids_json, source_ids_json,
           root_thread_id, started_at, ended_at, model, client_version, policy_version,
           project_context_json, warnings_json)
         VALUES ($id, $run_id, $client, $schema_version, $source_session_ids_json,
                 $source_ids_json, $root_thread_id, $started_at, $ended_at, $model,
                 $client_version, $policy_version, $project_context_json, $warnings_json)`,
        Object.keys(sessionValues).filter((key) => key !== 'id'),
        ['run_id', 'id'],
      );

      for (const thread of session.threads) {
        const values = {
          run_id: runId,
          id: thread.id,
          session_id: session.id,
          source_session_id: thread.sourceSessionId,
          parent_thread_id: thread.parentThreadId ?? null,
          agent_label: thread.agentLabel ?? null,
        };
        this.insertIdempotent(
          'session_threads',
          values,
          `INSERT INTO session_threads
            (run_id, id, session_id, source_session_id, parent_thread_id, agent_label)
           VALUES ($run_id, $id, $session_id, $source_session_id, $parent_thread_id,
                   $agent_label)`,
          ['source_session_id', 'parent_thread_id', 'agent_label'],
          ['run_id', 'session_id', 'id'],
        );
      }

      for (const event of session.events) {
        const values = {
          run_id: runId,
          id: event.id,
          session_id: session.id,
          thread_id: event.threadId,
          schema_version: event.schemaVersion,
          sequence: event.sequence,
          timestamp: event.timestamp ?? null,
          kind: event.kind,
          role: event.role,
          payload_json: json(event),
          actual_operation_id: event.actualOperationId ?? null,
        };
        this.insertIdempotent(
          'normalized_events',
          values,
          `INSERT INTO normalized_events
            (run_id, id, session_id, thread_id, schema_version, sequence, timestamp, kind,
             role, payload_json, actual_operation_id)
           VALUES ($run_id, $id, $session_id, $thread_id, $schema_version, $sequence,
                   $timestamp, $kind, $role, $payload_json, $actual_operation_id)`,
          Object.keys(values).filter((key) => !['run_id', 'id'].includes(key)),
          ['run_id', 'id'],
        );
      }

      for (const operation of session.actualOperations) {
        const values = {
          run_id: runId,
          id: operation.id,
          session_id: session.id,
          thread_id: operation.threadId,
          call_event_id: operation.callEventId,
          result_event_id: operation.resultEventId ?? null,
          schema_version: operation.schemaVersion,
          sequence: operation.sequence,
          timestamp: operation.timestamp ?? null,
          completed_at: operation.completedAt ?? null,
          tool: operation.tool,
          kind: operation.kind,
          source_tool_name: operation.sourceToolName,
          call_id: operation.callId,
          outcome: operation.outcome,
          payload_json: json(operation),
        };
        this.insertIdempotent(
          'actual_operations',
          values,
          `INSERT INTO actual_operations
            (run_id, id, session_id, thread_id, call_event_id, result_event_id,
             schema_version, sequence, timestamp, completed_at, tool, kind, source_tool_name,
             call_id, outcome, payload_json)
           VALUES ($run_id, $id, $session_id, $thread_id, $call_event_id, $result_event_id,
                   $schema_version, $sequence, $timestamp, $completed_at, $tool, $kind,
                   $source_tool_name, $call_id, $outcome, $payload_json)`,
          Object.keys(values).filter((key) => !['run_id', 'id'].includes(key)),
          ['run_id', 'id'],
        );
      }
    });
  }

  insertTask(input: TaskInput): void {
    const values = {
      run_id: input.runId,
      id: input.id,
      session_id: input.sessionId,
      ordinal: input.ordinal,
      start_sequence: input.startSequence,
      end_sequence: input.endSequence,
      title: input.title ?? null,
      summary: input.summary ?? null,
      context_json: input.context === undefined ? null : json(input.context),
      created_at: this.timestamp(),
    };
    this.insertIdempotent(
      'tasks',
      values,
      `INSERT INTO tasks
        (run_id, id, session_id, ordinal, start_sequence, end_sequence, title, summary,
         context_json, created_at)
       VALUES ($run_id, $id, $session_id, $ordinal, $start_sequence, $end_sequence,
               $title, $summary, $context_json, $created_at)`,
      [
        'session_id',
        'ordinal',
        'start_sequence',
        'end_sequence',
        'title',
        'summary',
        'context_json',
      ],
      ['run_id', 'id'],
    );
  }

  insertCheckpoint(input: CheckpointInput): void {
    const values = {
      run_id: input.runId,
      id: input.id,
      task_id: input.taskId,
      ordinal: input.ordinal,
      after_sequence: input.afterSequence,
      reason: input.reason,
      context_json: json(input.context),
      created_at: this.timestamp(),
    };
    this.insertIdempotent(
      'checkpoints',
      values,
      `INSERT INTO checkpoints
        (run_id, id, task_id, ordinal, after_sequence, reason, context_json, created_at)
       VALUES ($run_id, $id, $task_id, $ordinal, $after_sequence, $reason, $context_json,
               $created_at)`,
      ['task_id', 'ordinal', 'after_sequence', 'reason', 'context_json'],
      ['run_id', 'id'],
    );
  }

  insertProposal(input: ProposalInput): string {
    const id =
      input.id ??
      stableId(
        'prop',
        input.runId,
        input.taskId,
        input.checkpointId ?? null,
        input.ordinal,
        input.kind,
        input.payload,
      );
    const values = {
      id,
      run_id: input.runId,
      task_id: input.taskId,
      checkpoint_id: input.checkpointId ?? null,
      ordinal: input.ordinal,
      kind: input.kind,
      payload_json: json(input.payload),
      rationale: input.rationale ?? null,
      evaluator_json: json(input.evaluator),
      created_at: this.timestamp(),
    };
    this.insertIdempotent(
      'proposals',
      values,
      `INSERT INTO proposals
        (id, run_id, task_id, checkpoint_id, ordinal, kind, payload_json, rationale,
         evaluator_json, created_at)
       VALUES ($id, $run_id, $task_id, $checkpoint_id, $ordinal, $kind, $payload_json,
               $rationale, $evaluator_json, $created_at)`,
      [
        'run_id',
        'task_id',
        'checkpoint_id',
        'ordinal',
        'kind',
        'payload_json',
        'rationale',
        'evaluator_json',
      ],
    );
    return id;
  }

  insertComparison(input: ComparisonInput): string {
    if (input.proposalId === undefined && input.actualOperationId === undefined) {
      throw new Error('A comparison requires a proposal, an actual operation, or both.');
    }
    const id =
      input.id ??
      stableId(
        'cmp',
        input.runId,
        input.taskId,
        input.kind,
        input.proposalId ?? null,
        input.actualOperationId ?? null,
      );
    const values = {
      id,
      run_id: input.runId,
      task_id: input.taskId,
      kind: input.kind,
      proposal_id: input.proposalId ?? null,
      actual_operation_id: input.actualOperationId ?? null,
      label: input.label,
      explanation: input.explanation,
      duplicate_of_comparison_id: input.duplicateOfComparisonId ?? null,
      created_at: this.timestamp(),
    };
    this.insertIdempotent(
      'comparisons',
      values,
      `INSERT INTO comparisons
        (id, run_id, task_id, kind, proposal_id, actual_operation_id, label, explanation,
         duplicate_of_comparison_id, created_at)
       VALUES ($id, $run_id, $task_id, $kind, $proposal_id, $actual_operation_id,
               $label, $explanation, $duplicate_of_comparison_id, $created_at)`,
      [
        'run_id',
        'task_id',
        'kind',
        'proposal_id',
        'actual_operation_id',
        'label',
        'explanation',
        'duplicate_of_comparison_id',
      ],
    );
    return id;
  }

  recordReview(comparisonId: string, command: StoredReviewCommand): ReviewEvent {
    return this.transaction(() => {
      const comparison = this.comparisonRow(comparisonId);
      if (comparison === undefined) throw new Error(`Unknown review item: ${comparisonId}`);
      const events = this.reviewEvents(comparisonId);
      const state = reviewState(events);
      const latestPromotion = this.latestPromotion(comparisonId);
      const latestRevision = [...events].reverse().find((event) => event.revision !== undefined);
      const effectiveProposal =
        latestRevision?.revision ??
        (comparison.payload_json === null ? undefined : parseJson(comparison.payload_json));
      const promotionStatus = latestPromotion?.status;
      const promotionRepair =
        (promotionStatus === 'failed' ||
          promotionStatus === 'duplicate_candidates' ||
          promotionStatus === 'ambiguous') &&
        (command.action === 'edit' ||
          command.action === 'reject' ||
          command.action === 'duplicate');
      const prePromotionCorrection = latestPromotion === undefined && command.action === 'edit';
      const followUpAllowed =
        state === 'approved' &&
        comparison.kind === 'write' &&
        comparison.proposal_id !== null &&
        (promotionRepair ||
          prePromotionCorrection ||
          (command.action === 'edit' && hasUnresolvedProjectScope(effectiveProposal)));
      if (state !== 'pending' && !followUpAllowed) {
        throw new Error(`Review item ${comparisonId} is already ${state}; decisions are final.`);
      }
      validateReviewCommand(command);
      if (command.action === 'edit') {
        this.assertReviewedActualOperation(comparison, command.actualOperationId);
      }
      const sequence = events.length + 1;
      const createdAt = this.timestamp();
      const revision = command.action === 'edit' ? command.revision : undefined;
      const reason = command.action === 'approve' ? undefined : command.reason.trim();
      const target = command.action === 'duplicate' ? command.targetMemoryId.trim() : undefined;
      const id = stableId('rev', comparisonId, sequence, command.action, createdAt);
      this.db
        .prepare(
          `INSERT INTO review_events
            (id, comparison_id, sequence, action, reason, duplicate_target_memory_id,
             revision_json, label, actual_operation_id, actual_operation_set,
             target_snapshot_json, target_snapshot_set, actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          comparisonId,
          sequence,
          command.action,
          reason ?? null,
          target ?? null,
          revision === undefined ? null : json(revision),
          command.action === 'edit' ? command.label : null,
          command.action === 'edit' ? command.actualOperationId : null,
          command.action === 'edit' ? 1 : 0,
          command.targetMemorySnapshot == null ? null : json(command.targetMemorySnapshot),
          command.targetMemorySnapshot === undefined ? 0 : 1,
          command.actor.trim(),
          createdAt,
        );
      return {
        id,
        comparisonId,
        sequence,
        action: command.action,
        ...(reason === undefined ? {} : { reason }),
        ...(target === undefined ? {} : { duplicateTargetMemoryId: target }),
        ...(revision === undefined ? {} : { revision }),
        ...(command.action === 'edit' ? { label: command.label } : {}),
        ...(command.action === 'edit' ? { actualOperationId: command.actualOperationId } : {}),
        ...(command.targetMemorySnapshot === undefined
          ? {}
          : { targetMemorySnapshot: command.targetMemorySnapshot }),
        actor: command.actor.trim(),
        createdAt,
      };
    });
  }

  reviewItem(comparisonId: string): ReviewQueueItem {
    const row = this.comparisonRow(comparisonId);
    if (!row) throw new Error(`Unknown review item: ${comparisonId}`);
    return this.toReviewItem(row);
  }

  listReviewQueue(runId?: string, includeDecided = false): ReviewQueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, p.payload_json, t.summary AS task_summary, t.context_json AS task_context_json,
                cp.context_json AS checkpoint_context_json,
                a.payload_json AS actual_operation_json
         FROM comparisons c
         LEFT JOIN proposals p ON p.id = c.proposal_id
         JOIN tasks t ON t.run_id = c.run_id AND t.id = c.task_id
         LEFT JOIN checkpoints cp ON cp.run_id = p.run_id AND cp.id = p.checkpoint_id
         LEFT JOIN actual_operations a
           ON a.run_id = c.run_id AND a.id = c.actual_operation_id
         ${runId === undefined ? '' : 'WHERE c.run_id = ?'}
         ORDER BY c.created_at, c.id`,
      )
      .all(...(runId === undefined ? [] : [runId])) as unknown as ComparisonRow[];
    const items = rows.map((row) => this.toReviewItem(row));
    // `includeDecided` is the audit view (`queue --all`), and a collapsed
    // duplicate is exactly the kind of row an audit needs to see. Every other
    // caller wants one row per opportunity.
    return includeDecided
      ? items
      : items.filter(
          (item) =>
            item.duplicateOfComparisonId === undefined &&
            (item.state === 'pending' ||
              (item.state === 'approved' &&
                item.kind === 'write' &&
                item.proposalId !== undefined &&
                (['duplicate_candidates', 'ambiguous', 'failed'].includes(
                  this.latestPromotion(item.id)?.status ?? '',
                ) ||
                  hasUnresolvedProjectScope(item.revision ?? item.proposal)))),
        );
  }

  listReviewed(runId?: string): ReviewQueueItem[] {
    // Ground truth is per opportunity, so a collapsed duplicate never counts —
    // otherwise one opportunity would contribute several times to every rate.
    return this.listReviewQueue(runId, true).filter(
      (item) => item.state !== 'pending' && item.duplicateOfComparisonId === undefined,
    );
  }

  projectContextForComparison(comparisonId: string): ProjectContext | undefined {
    const row = this.db
      .prepare(
        `SELECT s.project_context_json
         FROM comparisons c
         JOIN tasks t ON t.run_id = c.run_id AND t.id = c.task_id
         JOIN sessions s ON s.run_id = t.run_id AND s.id = t.session_id
         WHERE c.id = ?`,
      )
      .get(comparisonId) as { project_context_json: string | null } | undefined;
    if (row === undefined) throw new Error(`Unknown review item: ${comparisonId}`);
    return row.project_context_json === null
      ? undefined
      : (parseJson(row.project_context_json) as unknown as ProjectContext);
  }

  latestPromotion(comparisonId: string): PromotionAttempt | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM promotion_attempts
         WHERE comparison_id = ? ORDER BY attempt DESC LIMIT 1`,
      )
      .get(comparisonId) as PromotionRow | undefined;
    return row === undefined ? undefined : toPromotion(row);
  }

  beginPromotion(comparisonId: string, proposal: JsonValue): PromotionAttempt {
    return this.claimPromotion(comparisonId, proposal).attempt;
  }

  claimPromotion(
    comparisonId: string,
    proposal: JsonValue,
    expectedReviewSequence?: number,
  ): { attempt: PromotionAttempt; claimed: boolean } {
    return this.transaction(() => {
      if (expectedReviewSequence !== undefined) {
        const comparison = this.comparisonRow(comparisonId);
        if (comparison === undefined) throw new Error(`Unknown review item: ${comparisonId}`);
        const events = this.reviewEvents(comparisonId);
        const latestRevision = [...events].reverse().find((event) => event.revision !== undefined);
        const effectiveProposal =
          latestRevision?.revision ??
          (comparison.payload_json === null ? undefined : parseJson(comparison.payload_json));
        if (
          events.length !== expectedReviewSequence ||
          reviewState(events) !== 'approved' ||
          effectiveProposal === undefined ||
          json(effectiveProposal) !== json(proposal)
        ) {
          throw new Error(
            `Review item ${comparisonId} changed before promotion could be claimed; reload it.`,
          );
        }
      }
      const latest = this.latestPromotion(comparisonId);
      if (latest && (latest.status === 'started' || latest.status === 'succeeded')) {
        return { attempt: latest, claimed: false };
      }
      const attempt = (latest?.attempt ?? 0) + 1;
      const startedAt = this.timestamp();
      const id = stableId('promotion', comparisonId, attempt);
      this.db
        .prepare(
          `INSERT INTO promotion_attempts
            (id, comparison_id, attempt, status, proposal_json, started_at)
           VALUES (?, ?, ?, 'started', ?, ?)`,
        )
        .run(id, comparisonId, attempt, json(proposal), startedAt);
      return {
        attempt: {
          id,
          comparisonId,
          attempt,
          status: 'started',
          proposal,
          startedAt,
        },
        claimed: true,
      };
    });
  }

  finishPromotion(
    id: string,
    outcome: {
      status: Exclude<PromotionStatus, 'started'>;
      result?: JsonValue;
      promotedMemoryId?: string;
      error?: string;
    },
  ): PromotionAttempt {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM promotion_attempts WHERE id = ?').get(id) as
        PromotionRow | undefined;
      if (!current) throw new Error(`Unknown promotion attempt: ${id}`);
      if (current.status !== 'started') return toPromotion(current);
      const completedAt = this.timestamp();
      this.db
        .prepare(
          `UPDATE promotion_attempts
           SET status = ?, result_json = ?, promoted_memory_id = ?, error = ?, completed_at = ?
           WHERE id = ? AND status = 'started'`,
        )
        .run(
          outcome.status,
          outcome.result === undefined ? null : json(outcome.result),
          outcome.promotedMemoryId ?? null,
          outcome.error ?? null,
          completedAt,
          id,
        );
      return toPromotion({
        ...current,
        status: outcome.status,
        result_json: outcome.result === undefined ? null : json(outcome.result),
        promoted_memory_id: outcome.promotedMemoryId ?? null,
        error: outcome.error ?? null,
        completed_at: completedAt,
      });
    });
  }

  counts(): Record<string, number> {
    return Object.fromEntries(
      [
        'runs',
        'sessions',
        'source_references',
        'session_threads',
        'normalized_events',
        'tasks',
        'task_failures',
        'checkpoints',
        'actual_operations',
        'proposals',
        'comparisons',
        'review_events',
        'promotion_attempts',
      ].map((table) => {
        const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        };
        return [table, row.count];
      }),
    );
  }

  query<T extends object>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const current = this.schemaVersion();
    if (current > RETROSPECTIVE_SCHEMA_VERSION) {
      throw new Error(
        `Retrospective database schema ${current} is newer than supported version ` +
          `${RETROSPECTIVE_SCHEMA_VERSION}.`,
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      if (migration.version !== this.schemaVersion() + 1) {
        throw new Error(`Retrospective migration ${migration.version} is not sequential.`);
      }
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, this.timestamp());
      });
    }
  }

  private insertIdempotent(
    table: string,
    values: Record<string, string | number | null>,
    sql: string,
    compareColumns: string[],
    keyColumns: string[] = ['id'],
  ): void {
    try {
      this.db.prepare(sql).run(values);
      return;
    } catch (error) {
      if (!isConstraintError(error)) throw error;
    }
    const where = keyColumns.map((column) => `${column} = $${column}`).join(' AND ');
    const keys = Object.fromEntries(keyColumns.map((column) => [column, values[column] ?? null]));
    const existing = this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(keys) as
      Record<string, unknown> | undefined;
    if (!existing) throw new Error(`Conflicting unique key while inserting ${table}.`);
    const changed = compareColumns.filter((column) => existing[column] !== values[column]);
    if (changed.length > 0) {
      throw new Error(
        `Idempotency conflict in ${table} for ${keyColumns.map((key) => values[key]).join('/')}: ` +
          `${changed.join(', ')} changed.`,
      );
    }
  }

  private reviewEvents(comparisonId: string): ReviewEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM review_events WHERE comparison_id = ? ORDER BY sequence')
      .all(comparisonId) as unknown as ReviewRow[];
    return rows.map(toReviewEvent);
  }

  private comparisonRow(comparisonId: string): ComparisonRow | undefined {
    return this.db
      .prepare(
        `SELECT c.*, p.payload_json, t.summary AS task_summary,
                t.context_json AS task_context_json,
                cp.context_json AS checkpoint_context_json,
                a.payload_json AS actual_operation_json
         FROM comparisons c
         LEFT JOIN proposals p ON p.id = c.proposal_id
         JOIN tasks t ON t.run_id = c.run_id AND t.id = c.task_id
         LEFT JOIN checkpoints cp ON cp.run_id = p.run_id AND cp.id = p.checkpoint_id
         LEFT JOIN actual_operations a
           ON a.run_id = c.run_id AND a.id = c.actual_operation_id
         WHERE c.id = ?`,
      )
      .get(comparisonId) as ComparisonRow | undefined;
  }

  private toReviewItem(row: ComparisonRow): ReviewQueueItem {
    const events = this.reviewEvents(row.id);
    const latestRevision = [...events].reverse().find((event) => event.revision !== undefined);
    const reviewedLabel = [...events].reverse().find((event) => event.label !== undefined)?.label;
    const reviewedMatch = [...events]
      .reverse()
      .find((event) => event.actualOperationId !== undefined);
    const reviewedTarget = [...events]
      .reverse()
      .find((event) => event.targetMemorySnapshot !== undefined)?.targetMemorySnapshot;
    const actualOperationId =
      reviewedMatch === undefined ? row.actual_operation_id : reviewedMatch.actualOperationId;
    const actualOperationJson =
      actualOperationId === null || actualOperationId === undefined
        ? null
        : actualOperationId === row.actual_operation_id
          ? row.actual_operation_json
          : ((
              this.db
                .prepare('SELECT payload_json FROM actual_operations WHERE run_id = ? AND id = ?')
                .get(row.run_id, actualOperationId) as { payload_json: string } | undefined
            )?.payload_json ?? null);
    return {
      id: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      kind: row.kind,
      ...(row.duplicate_of_comparison_id === null
        ? {}
        : { duplicateOfComparisonId: row.duplicate_of_comparison_id }),
      ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id }),
      ...(actualOperationId === null || actualOperationId === undefined
        ? {}
        : { actualOperationId }),
      ...(row.actual_operation_id === null
        ? {}
        : { originalActualOperationId: row.actual_operation_id }),
      label: reviewedLabel ?? row.label,
      originalLabel: row.label,
      explanation: row.explanation,
      state: reviewState(events),
      ...(row.payload_json === null ? {} : { proposal: parseJson(row.payload_json) }),
      ...(latestRevision?.revision === undefined ? {} : { revision: latestRevision.revision }),
      ...(row.task_summary === null ? {} : { taskSummary: row.task_summary }),
      ...(row.checkpoint_context_json === null && row.task_context_json === null
        ? {}
        : {
            context: parseJson(row.checkpoint_context_json ?? row.task_context_json!),
          }),
      ...(actualOperationJson === null ? {} : { actualOperation: parseJson(actualOperationJson) }),
      ...(reviewedTarget == null ? {} : { targetMemorySnapshot: reviewedTarget }),
      reviewEvents: events,
    };
  }

  private assertReviewedActualOperation(
    comparison: ComparisonRow,
    actualOperationId: string | null,
  ): void {
    if (actualOperationId === null) return;
    const operation = this.db
      .prepare(
        `SELECT a.kind
         FROM actual_operations a
         JOIN tasks t ON t.run_id = a.run_id AND t.session_id = a.session_id
         WHERE a.run_id = ? AND a.id = ? AND t.id = ?
           AND a.sequence BETWEEN t.start_sequence AND t.end_sequence`,
      )
      .get(comparison.run_id, actualOperationId, comparison.task_id) as
      { kind: 'search' | 'write' | 'project' | 'read' | 'archive' } | undefined;
    const expectedKind = comparison.kind === 'search' ? 'search' : 'write';
    if (operation?.kind !== expectedKind) {
      throw new Error(
        `Reviewed actual operation ${actualOperationId} is not a ${expectedKind} operation in ` +
          `task ${comparison.task_id}.`,
      );
    }
    const conflicting = this.listReviewQueue(comparison.run_id, true).find(
      (item) =>
        item.id !== comparison.id &&
        item.state !== 'rejected' &&
        item.state !== 'duplicate' &&
        item.actualOperationId === actualOperationId,
    );
    if (conflicting !== undefined) {
      throw new Error(
        `Reviewed actual operation ${actualOperationId} is already matched to ${conflicting.id}.`,
      );
    }
  }

  private assertExists(table: 'runs' | 'comparisons', id: string): void {
    const row = this.db.prepare(`SELECT 1 AS found FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new Error(`Unknown ${table.slice(0, -1)}: ${id}`);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  withTransaction<T>(operation: () => T): T {
    return this.transaction(operation);
  }

  private transaction<T>(operation: () => T): T {
    if (this.db.isTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

interface ComparisonRow {
  id: string;
  run_id: string;
  task_id: string;
  kind: 'search' | 'write';
  proposal_id: string | null;
  actual_operation_id: string | null;
  label: ReviewQueueItem['label'];
  explanation: string;
  duplicate_of_comparison_id: string | null;
  payload_json: string | null;
  task_summary: string | null;
  task_context_json: string | null;
  checkpoint_context_json: string | null;
  actual_operation_json: string | null;
}

interface TaskFailureRow {
  run_id: string;
  id: string;
  session_id: string;
  ordinal: number;
  start_sequence: number;
  end_sequence: number;
  error: string;
  created_at: string;
}

interface RunRow {
  id: string;
  source_policy_version: string;
  pipeline_version: string;
  status: RunStatus;
  evaluator_json: string | null;
  metadata_json: string;
  created_at: string;
}

interface ReviewRow {
  id: string;
  comparison_id: string;
  sequence: number;
  action: ReviewEvent['action'];
  reason: string | null;
  duplicate_target_memory_id: string | null;
  revision_json: string | null;
  label: ReviewEvent['label'] | null;
  actual_operation_id: string | null;
  actual_operation_set: 0 | 1;
  target_snapshot_json: string | null;
  target_snapshot_set: 0 | 1;
  actor: string;
  created_at: string;
}

interface PromotionRow {
  id: string;
  comparison_id: string;
  attempt: number;
  status: PromotionStatus;
  proposal_json: string;
  result_json: string | null;
  promoted_memory_id: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

function reviewState(events: readonly ReviewEvent[]): ReviewState {
  const latest = events.at(-1);
  if (latest === undefined) return 'pending';
  if (latest.action === 'approve' || latest.action === 'edit') return 'approved';
  if (latest.action === 'reject') return 'rejected';
  return 'duplicate';
}

function hasUnresolvedProjectScope(proposal: JsonValue | undefined): boolean {
  if (
    proposal === undefined ||
    proposal === null ||
    typeof proposal !== 'object' ||
    Array.isArray(proposal)
  )
    return false;
  const memory = proposal.memory;
  if (
    memory === undefined ||
    memory === null ||
    typeof memory !== 'object' ||
    Array.isArray(memory)
  )
    return false;
  const scope = memory.scope;
  return (
    scope !== undefined &&
    scope !== null &&
    typeof scope === 'object' &&
    !Array.isArray(scope) &&
    scope.kind === 'unresolved_projects'
  );
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    sourcePolicyVersion: row.source_policy_version,
    pipelineVersion: row.pipeline_version,
    status: row.status,
    ...(row.evaluator_json === null
      ? {}
      : { evaluator: parseJson(row.evaluator_json) as unknown as EvaluatorIdentity }),
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function validateReviewCommand(command: ReviewCommand): void {
  if (command.actor.trim() === '') throw new Error('Review actor is required.');
  if (command.action !== 'approve' && command.reason.trim() === '') {
    throw new Error(`${command.action} requires a reason.`);
  }
  if (command.action === 'duplicate' && command.targetMemoryId.trim() === '') {
    throw new Error('duplicate requires a target memory id.');
  }
  if (command.action === 'edit' && !COMPARISON_LABELS.includes(command.label)) {
    throw new Error('edit requires a valid reviewed comparison label.');
  }
}

function toReviewEvent(row: ReviewRow): ReviewEvent {
  return {
    id: row.id,
    comparisonId: row.comparison_id,
    sequence: row.sequence,
    action: row.action,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.duplicate_target_memory_id === null
      ? {}
      : { duplicateTargetMemoryId: row.duplicate_target_memory_id }),
    ...(row.revision_json === null ? {} : { revision: parseJson(row.revision_json) }),
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.actual_operation_set === 0 ? {} : { actualOperationId: row.actual_operation_id }),
    ...(row.target_snapshot_set === 0
      ? {}
      : {
          targetMemorySnapshot:
            row.target_snapshot_json === null
              ? null
              : (parseJson(
                  row.target_snapshot_json,
                ) as unknown as ReviewEvent['targetMemorySnapshot']),
        }),
    actor: row.actor,
    createdAt: row.created_at,
  };
}

function toPromotion(row: PromotionRow): PromotionAttempt {
  return {
    id: row.id,
    comparisonId: row.comparison_id,
    attempt: row.attempt,
    status: row.status,
    proposal: parseJson(row.proposal_json),
    ...(row.result_json === null ? {} : { result: parseJson(row.result_json) }),
    ...(row.promoted_memory_id === null ? {} : { promotedMemoryId: row.promoted_memory_id }),
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as Error & { code?: unknown }).code) : '';
  return code.includes('CONSTRAINT') || error.message.toLowerCase().includes('constraint');
}

function json(value: unknown): string {
  return stableJson(value as JsonValue);
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}
