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
    print('');
    print(
      `Note: the built-in model gateway is available but disabled because ${options.bundledDefaultSuppressedBy} already sets model settings.`
    );
    print(
      'Remove them (moss config unset provider|model|baseUrl) or complete them with an API key.'
    );
  }
  print('');
  print('Fast path:');
  print('  moss setup');
  print('');
  print('Script path (no TTY — model settings are read from config files, never env vars):');
  print('  moss config set provider deepseek');
  print('  moss config set model deepseek-v4-flash');
  print('  # for the API key, use moss setup (hidden prompt) or write it into a JSON config file:');
  print(
    '  # WARNING: moss config set apiKey <key> leaves the key in your shell history — prefer moss setup.'
  );
  print('  moss --config-file /path/to/config.json  # {"provider":"deepseek","apiKey":"..."}');
  print('');
  if (interactive) {
    print('You can run setup now, then start `moss` again.');
  } else {
    print('Run moss setup to configure a model, then retry your one-shot command.');
  }
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
