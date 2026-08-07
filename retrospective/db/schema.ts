export const RETROSPECTIVE_SCHEMA_VERSION = 6 as const;

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        source_policy_version TEXT NOT NULL,
        pipeline_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ingested', 'evaluated', 'reviewing', 'complete')),
        evaluator_json TEXT CHECK (evaluator_json IS NULL OR json_valid(evaluator_json)),
        metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        run_id TEXT NOT NULL REFERENCES runs(id),
        id TEXT NOT NULL,
        client TEXT NOT NULL CHECK (client IN ('claude-code', 'codex')),
        schema_version INTEGER NOT NULL,
        source_session_ids_json TEXT NOT NULL CHECK (json_valid(source_session_ids_json)),
        source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
        root_thread_id TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        model TEXT,
        client_version TEXT,
        policy_version TEXT NOT NULL,
        project_context_json TEXT CHECK (
          project_context_json IS NULL OR json_valid(project_context_json)
        ),
        warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
        PRIMARY KEY (run_id, id)
      ) STRICT;

      CREATE TABLE source_references (
        run_id TEXT NOT NULL REFERENCES runs(id),
        source_id TEXT NOT NULL,
        client TEXT NOT NULL CHECK (client IN ('claude-code', 'codex')),
        path TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (
          length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        ingested_at TEXT NOT NULL,
        PRIMARY KEY (run_id, source_id)
      ) STRICT;

      CREATE TABLE session_threads (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        parent_thread_id TEXT,
        agent_label TEXT,
        PRIMARY KEY (run_id, session_id, id),
        FOREIGN KEY (run_id, session_id) REFERENCES sessions(run_id, id)
      ) STRICT;

      CREATE TABLE tasks (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        start_sequence INTEGER NOT NULL CHECK (start_sequence >= 0),
        end_sequence INTEGER NOT NULL CHECK (end_sequence >= start_sequence),
        title TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, id),
        UNIQUE (run_id, session_id, ordinal),
        UNIQUE (run_id, session_id, start_sequence, end_sequence),
        FOREIGN KEY (run_id, session_id) REFERENCES sessions(run_id, id)
      ) STRICT;

      CREATE TABLE normalized_events (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        timestamp TEXT,
        kind TEXT NOT NULL CHECK (
          kind IN ('user_message', 'assistant_message', 'tool_call', 'tool_result')
        ),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        actual_operation_id TEXT,
        PRIMARY KEY (run_id, id),
        UNIQUE (run_id, session_id, sequence, id),
        FOREIGN KEY (run_id, session_id, thread_id)
          REFERENCES session_threads(run_id, session_id, id)
      ) STRICT;

      CREATE TABLE checkpoints (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        after_sequence INTEGER NOT NULL CHECK (after_sequence >= 0),
        reason TEXT NOT NULL,
        context_json TEXT NOT NULL CHECK (json_valid(context_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, id),
        UNIQUE (run_id, task_id, ordinal),
        UNIQUE (run_id, task_id, after_sequence),
        FOREIGN KEY (run_id, task_id) REFERENCES tasks(run_id, id)
      ) STRICT;

      CREATE TABLE actual_operations (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        call_event_id TEXT NOT NULL,
        result_event_id TEXT,
        schema_version INTEGER NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        timestamp TEXT,
        completed_at TEXT,
        tool TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('project', 'search', 'read', 'write', 'archive')),
        source_tool_name TEXT NOT NULL,
        call_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('unknown', 'success', 'error')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        PRIMARY KEY (run_id, id),
        UNIQUE (run_id, session_id, call_id),
        FOREIGN KEY (run_id, session_id, thread_id)
          REFERENCES session_threads(run_id, session_id, id),
        FOREIGN KEY (run_id, call_event_id) REFERENCES normalized_events(run_id, id),
        FOREIGN KEY (run_id, result_event_id) REFERENCES normalized_events(run_id, id)
      ) STRICT;

      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        checkpoint_id TEXT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('search', 'create', 'update')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        rationale TEXT,
        evaluator_json TEXT NOT NULL CHECK (json_valid(evaluator_json)),
        created_at TEXT NOT NULL,
        CHECK (
          (kind = 'search' AND checkpoint_id IS NOT NULL) OR
          (kind IN ('create', 'update') AND checkpoint_id IS NULL)
        ),
        UNIQUE (run_id, task_id, checkpoint_id, ordinal, kind),
        FOREIGN KEY (run_id, task_id) REFERENCES tasks(run_id, id),
        FOREIGN KEY (run_id, checkpoint_id) REFERENCES checkpoints(run_id, id)
      ) STRICT;

      CREATE TABLE comparisons (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('search', 'write')),
        proposal_id TEXT REFERENCES proposals(id),
        actual_operation_id TEXT,
        label TEXT NOT NULL CHECK (
          label IN (
            'timely', 'late', 'missed', 'unnecessary_candidate', 'incorrect_scope',
            'ambiguous', 'transcript_only', 'attempted_not_stored'
          )
        ),
        explanation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (proposal_id IS NOT NULL OR actual_operation_id IS NOT NULL),
        FOREIGN KEY (run_id, task_id) REFERENCES tasks(run_id, id),
        FOREIGN KEY (run_id, actual_operation_id) REFERENCES actual_operations(run_id, id)
      ) STRICT;

      CREATE UNIQUE INDEX comparisons_one_proposal
        ON comparisons(proposal_id) WHERE proposal_id IS NOT NULL;
      CREATE UNIQUE INDEX comparisons_one_actual_operation
        ON comparisons(run_id, actual_operation_id) WHERE actual_operation_id IS NOT NULL;
      CREATE INDEX comparisons_run_queue ON comparisons(run_id, created_at, id);

      CREATE TABLE review_events (
        id TEXT PRIMARY KEY,
        comparison_id TEXT NOT NULL REFERENCES comparisons(id),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        action TEXT NOT NULL CHECK (action IN ('approve', 'edit', 'reject', 'duplicate')),
        reason TEXT,
        duplicate_target_memory_id TEXT,
        revision_json TEXT CHECK (revision_json IS NULL OR json_valid(revision_json)),
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (action != 'edit' OR (reason IS NOT NULL AND revision_json IS NOT NULL)),
        CHECK (action != 'reject' OR reason IS NOT NULL),
        CHECK (
          action != 'duplicate' OR
          (reason IS NOT NULL AND duplicate_target_memory_id IS NOT NULL)
        ),
        CHECK (action != 'approve' OR revision_json IS NULL),
        UNIQUE (comparison_id, sequence)
      ) STRICT;

      CREATE TABLE promotion_attempts (
        id TEXT PRIMARY KEY,
        comparison_id TEXT NOT NULL REFERENCES comparisons(id),
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        status TEXT NOT NULL CHECK (
          status IN ('started', 'succeeded', 'duplicate_candidates', 'failed', 'ambiguous')
        ),
        proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        promoted_memory_id TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK ((status = 'started') = (completed_at IS NULL)),
        UNIQUE (comparison_id, attempt)
      ) STRICT;

      CREATE INDEX promotion_attempts_comparison
        ON promotion_attempts(comparison_id, attempt DESC);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE task_failures (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        start_sequence INTEGER NOT NULL CHECK (start_sequence >= 0),
        end_sequence INTEGER NOT NULL CHECK (end_sequence >= start_sequence),
        error TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, id),
        UNIQUE (run_id, session_id, ordinal),
        FOREIGN KEY (run_id, session_id) REFERENCES sessions(run_id, id)
      ) STRICT;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE tasks ADD COLUMN context_json TEXT
        CHECK (context_json IS NULL OR json_valid(context_json));
      ALTER TABLE review_events ADD COLUMN label TEXT
        CHECK (
          label IS NULL OR label IN (
            'timely', 'late', 'missed', 'unnecessary_candidate', 'incorrect_scope',
            'ambiguous', 'transcript_only', 'attempted_not_stored'
          )
        );
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE review_events ADD COLUMN actual_operation_id TEXT;
      ALTER TABLE review_events ADD COLUMN actual_operation_set INTEGER NOT NULL DEFAULT 0
        CHECK (actual_operation_set IN (0, 1));
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE review_events ADD COLUMN target_snapshot_json TEXT
        CHECK (target_snapshot_json IS NULL OR json_valid(target_snapshot_json));
      ALTER TABLE review_events ADD COLUMN target_snapshot_set INTEGER NOT NULL DEFAULT 0
        CHECK (target_snapshot_set IN (0, 1));
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE comparisons ADD COLUMN duplicate_of_comparison_id TEXT
        REFERENCES comparisons(id);

      CREATE INDEX comparisons_duplicate_of
        ON comparisons(duplicate_of_comparison_id)
        WHERE duplicate_of_comparison_id IS NOT NULL;
    `,
  },
];
