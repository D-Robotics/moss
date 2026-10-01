/**
 * Thin re-export shell for the former single-file `cli/setup.ts`, now split
 * into three command-domain modules:
 *
 *   - `setup-wizard.ts`     — `moss setup` wizard, auth status/logout, shared CLI I/O helpers
 *   - `config-commands.ts`  — `moss config` show/validate/set/unset/init
 *   - `onboarding-hints.ts` — missing-config guidance and one-shot onboarding marker
 *
 * Kept at the original path so consumers importing `dist/cli/setup.js`
 * (test/cli-setup-commands.spec.mjs) keep working unchanged. In-repo modules
 * import the new modules directly. The exported surface is exactly the
 * historical surface of this former single-file module.
 */

export {
  probeSetupReachability,
  renderAuthStatus,
  runAuthLogout,
  runSetupWizard,
} from './setup-wizard.js';
export {
  renderConfigJson,
  renderConfigUsage,
  renderConfigHelp,
  runConfigInit,
  runConfigSet,
  runConfigShow,
  runConfigUnset,
  runConfigValidate,
} from './config-commands.js';
export {
  hasShownOneShotOnboardingHint,
  markOneShotOnboardingShown,
  offerSetupForInteractiveMissingConfig,
  printMissingConfigGuidance,
  renderOneShotOnboardingHint,
} from './onboarding-hints.js';
