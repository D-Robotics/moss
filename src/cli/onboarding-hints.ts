import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir } from './config.js';
import { setupCopy } from './cli-locale.js';
import {
  detectEnvCredentials,
  offerUsesOfficialHost,
  type DetectedCredential,
} from './env-credentials.js';
import { probeModel } from './connection-probe.js';
import { saveUserModelConfig } from './first-run.js';
import { print, question, runSetupWizard } from './setup-wizard.js';

function L(en: string, vars?: Record<string, string | number>): string {
  return setupCopy(undefined, en, vars);
}

function officialOffers(offers: readonly DetectedCredential[]): DetectedCredential[] {
  return offers.filter((offer) => offerUsesOfficialHost(offer));
}

/** Same sentence in the guidance block and the one-shot hint. The hint indents it. */
function offerLine(padded: boolean): string | undefined {
  const offers = detectEnvCredentials();
  const official = officialOffers(offers);
  const pad = padded ? '  ' : '';
  if (official.length > 0) {
    return L(
      `${pad}{names} is set. Run \`moss\` and press Enter to use it (the value is not printed).`,
      { names: official.map((offer) => offer.keyVar).join(', ') }
    );
  }
  if (offers.length === 0) return undefined;
  return L(
    `${pad}{names} is set for {host}. Run \`moss\` and press its number to use that host. Enter will not send the key there.`,
    {
      names: offers.map((offer) => offer.keyVar).join(', '),
      host: offers.map((offer) => offer.baseUrl).join(', '),
    }
  );
}

export function printMissingConfigGuidance(
  interactive: boolean,
  options: { bundledDefaultSuppressedBy?: string } = {}
): void {
  const line = offerLine(false);
  if (line) print(line);
  print(L('Moss needs a model configuration before it can run.'));
  if (options.bundledDefaultSuppressedBy) {
    print(
      L(
        'Note: the built-in model gateway is disabled because {reason} already sets model settings — remove them (moss config unset provider|model|baseUrl) or add an API key.',
        { reason: options.bundledDefaultSuppressedBy }
      )
    );
  }
  print('');
  print(L('  moss                          # interactive setup, then the prompt'));
  print(L('  moss setup                    # same setup, without opening the chat'));
  print('');
  print(
    interactive
      ? L('Finish setup, then ask moss to look around this folder.')
      : L('Configure a model, then retry your command.')
  );
}

export async function offerSetupForInteractiveMissingConfig(
  options: { bundledDefaultSuppressedBy?: string } = {}
): Promise<boolean> {
  const offers = detectEnvCredentials();
  if (
    offers.length === 1 &&
    offers[0] &&
    !offers[0].needsModelList &&
    offerUsesOfficialHost(offers[0])
  ) {
    const offer = offers[0];
    print(
      L(
        'Found {label}. Press Enter to use it, or n to choose a provider. The value is not shown.',
        {
          label: offer.label,
        }
      )
    );
    const answer = await question(L('Use it? [Y/n] '));
    if (!answer || /^y(es)?$/i.test(answer)) {
      const probe = await probeModel({
        provider: offer.provider,
        baseUrl: offer.baseUrl,
        apiKey: offer.apiKey,
        model: offer.model,
      });
      print(probe.message);
      if (probe.ok) {
        const savedPath = saveUserModelConfig({
          provider: offer.provider,
          model: offer.model,
          baseUrl: offer.baseUrl,
          apiKeyEnv: offer.keyVar,
        });
        print(L('Saved → {path}', { path: savedPath }));
        return true;
      }
      print(L('That key did not connect. Starting provider setup.'));
    }
  }
  printMissingConfigGuidance(true, options);
  const answer = await question(L('Start setup now? [Y/n] '));
  if (!answer || /^y(es)?$/i.test(answer)) {
    await runSetupWizard();
    return true;
  }
  print(L('Setup skipped. Run `moss` when you are ready.'));
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
    L('[moss] No model configured yet.'),
    offerLine(true) ?? L('  Run `moss` to set up a provider, model, and API key.'),
    L('  (This hint appears only once.)'),
  ].join('\n');
}
