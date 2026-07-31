// Memento — local coding-agent memory layer (MCP server).

export const name = 'memento';

export { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export { DEFAULT_CONFIG, loadConfig, resolveHome, resolvePaths } from './config.js';
export type { MementoConfig, MementoPaths, ResolvedConfig } from './config.js';
export { MementoError, toErrorShape } from './errors.js';
export type { MementoErrorCode, MementoErrorShape } from './errors.js';
export { validate } from './validation.js';
export type { FieldError } from './validation.js';
export { parseFrontmatter, serializeFrontmatter } from './store/frontmatter.js';
export type { ParsedMemory } from './store/frontmatter.js';
export {
  EVIDENCE_KINDS,
  MEMORY_SCOPE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  PROJECT_MATCH_MODES,
  PROVENANCE_SOURCES,
  VERIFICATION_LEVELS,
  memoryFrontmatterSchema,
  validateMemoryFrontmatter,
} from './store/memory-schema.js';
export type {
  EvidenceEntry,
  MemoryDetail,
  MemoryProvenance,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  MemorySummary,
  MemoryType,
  ProvenanceSource,
  VerificationLevel,
} from './store/memory-schema.js';
export {
  PROJECT_STATUSES,
  projectFrontmatterSchema,
  validateProjectFrontmatter,
} from './store/project-schema.js';
export type { ProjectRecord, ProjectStatus, ProjectSummary } from './store/project-schema.js';
export { generateId, generateProjectId, slugify, memoryFilename } from './store/id.js';
export { atomicWrite, ensureDir } from './store/atomic.js';
export { createMemory } from './store/memory-create.js';
export type { CreateMemoryOptions, CreateMemoryResult } from './store/memory-create.js';
export { getMemory } from './store/memory-get.js';
export { updateMemory } from './store/memory-update.js';
export { archiveMemory } from './store/memory-archive.js';
export { searchMemories } from './store/memory-search.js';
export { createProject } from './store/project-create.js';
export { resolveProject } from './store/project-resolve.js';
export { updateProject } from './store/project-update.js';
