// Memento — local coding-agent memory layer (MCP server).

export const name = 'memento';

export { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export { DEFAULT_CONFIG, loadConfig, resolveHome, resolvePaths } from './config.js';
export type { MementoConfig, MementoPaths, ResolvedConfig } from './config.js';
