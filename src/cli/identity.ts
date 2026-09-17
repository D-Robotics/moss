// Re-export from agent layer — identity functions are now in core/agent/identity.ts
// so embedders can use them without the CLI.
export {
  buildMossCliIdentity,
  buildModelHonestyFooter,
  MOSS_CLI_IDENTITY,
} from '../core/agent/identity.js';
