// Re-export from agent layer — soul.md discovery is now in core/agent/soul.ts
// so embedders can use it without the CLI.
export { resolveSoulIdentity, resolveSoul } from '../core/agent/soul.js';
