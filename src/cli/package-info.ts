/**
 * CLI-facing alias of the inner package-metadata helpers. The implementation
 * moved to `src/utils/package-info.ts` (the MCP client in core needs the real
 * version too, and core must not import cli); this path stays stable so the
 * existing CLI imports keep working.
 */
export { getPackageJsonPath, getPackageVersion } from '../utils/package-info.js';
