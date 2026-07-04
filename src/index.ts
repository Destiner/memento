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
  MEMORY_TYPES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  CONFIDENCE_LEVELS,
  IMPORTANCE_LEVELS,
  frontmatterSchema,
  validateFrontmatter,
} from './store/schema.js';
export type {
  MemoryType,
  MemoryScope,
  MemoryStatus,
  Confidence,
  Importance,
  MemoryMetadata,
} from './store/schema.js';
export { generateId, slugify, memoryFilename } from './store/id.js';
export { atomicWrite, ensureDir } from './store/atomic.js';
export { createMemory } from './store/create.js';
export type { CreateMemoryOptions, CreateMemoryResult } from './store/create.js';
