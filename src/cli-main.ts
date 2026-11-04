/**
 * `moss` CLI entry.
 *
 * The host shell was 2,024 lines of wiring; it is now an entry shim. Runtime
 * wiring lives in `cli/runtime.ts` (W5b); the surface split arrives in W5c.
 * `cli.ts` imports this module for its side effect, as before.
 */
import { c } from './cli/bootstrap.js';
import { handleFatal, runCli } from './cli/runtime.js';

export { c };

runCli().catch(handleFatal);
