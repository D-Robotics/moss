/**
 * The skill tool moved into `core/skills` so the agent can register it without
 * crossing the core -> tools boundary. Kept as a re-export for hosts that
 * imported the tool implementation from here.
 */
export * from '../core/skills/skill-tool.js';
