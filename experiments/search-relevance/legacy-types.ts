// Frozen structural inputs used by the 0.4.0 index. No production runtime imports.
export type MemoryType =
  | 'debugging_pattern'
  | 'cross_project_context'
  | 'decision_history'
  | 'product_rationale'
  | 'preference'
  | 'environment_workflow_quirk'
  | 'papercut'
  | 'other';
export type MemoryStatus = 'active' | 'archived';
export type ProjectMatchMode = 'any' | 'all';
export type MemoryScope = { kind: 'global' } | { kind: 'projects'; project_ids: string[] };
export type SearchScope =
  { kind: 'global' } | { kind: 'projects'; project_ids: string[]; match: ProjectMatchMode };
export type ProvenanceSource = 'user_stated' | 'agent_observed' | 'external_reference' | 'inferred';
export type VerificationLevel =
  'unverified' | 'observed_once' | 'user_confirmed' | 'source_confirmed';
export interface MemoryRecord {
  id: string;
  title: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  status: MemoryStatus;
  provenance: { source: ProvenanceSource; verification: VerificationLevel };
  created_at: string;
  updated_at: string;
  archive_reason?: string;
}
export function memoryProjectIds(record: MemoryRecord): string[] {
  return record.scope.kind === 'projects' ? [...record.scope.project_ids] : [];
}
