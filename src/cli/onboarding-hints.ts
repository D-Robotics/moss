import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir } from './config.js';
import { print, question, runSetupWizard } from './setup-wizard.js';

export function printMissingConfigGuidance(
  interactive: boolean,
  options: { bundledDefaultSuppressedBy?: string } = {}
): void {
  print('Moss needs a model configuration before it can run.');
  if (options.bundledDefaultSuppressedBy) {
    print(
      `Note: the built-in model gateway is disabled because ${options.bundledDefaultSuppressedBy} already sets model settings — remove them (moss config unset provider|model|baseUrl) or add an API key.`
    );
  }
  print('');
  print('  moss setup                                      # interactive: provider + model + key');
  print('  moss config set provider <p> && moss config set model <m>   # script path (no TTY)');
  print(
    '  # API key: prefer `moss setup` (hidden prompt) — `config set apiKey` stays in shell history.'
  );
  print('');
  print(
    interactive
      ? 'Run setup, then start `moss` again.'
      : 'Configure a model, then retry your command.'
  );
}

export async function offerSetupForInteractiveMissingConfig(
  options: { bundledDefaultSuppressedBy?: string } = {}
): Promise<boolean> {
  printMissingConfigGuidance(true, options);
  const answer = await question('Start setup now? [Y/n] ');
  if (!answer || /^y(es)?$/i.test(answer)) {
    await runSetupWizard();
    return true;
  }
  print('Setup skipped. Run `moss setup` when you are ready.');
  process.exitCode = 1;
  return false;
}

const ONE_SHOT_ONBOARDING_MARKER = '.moss_onboarding_shown';

function oneShotOnboardingMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveConfigDir(env), ONE_SHOT_ONBOARDING_MARKER);
}

export function hasShownOneShotOnboardingHint(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.existsSync(oneShotOnboardingMarkerPath(env));
  } catch {
    return false;
  }
}

export function markOneShotOnboardingShown(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = resolveConfigDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, ONE_SHOT_ONBOARDING_MARKER), '', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {}
}

export function renderOneShotOnboardingHint(): string {
  return [
    '[moss] No model configured yet.',
    '  Run `moss setup` to configure one, or tell me: "help me add a model configuration."',
    '  (This hint appears only once.)',
  ].join('\n');
}
