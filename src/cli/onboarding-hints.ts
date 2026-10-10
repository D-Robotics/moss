import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir } from './config.js';
import { uiText } from './cli-locale.js';
import { print, question, runSetupWizard } from './setup-wizard.js';

export function printMissingConfigGuidance(
  interactive: boolean,
  options: { bundledDefaultSuppressedBy?: string } = {}
): void {
  print(
    uiText('Moss needs a model configuration before it can run.', 'Moss 需要先配置模型才能运行。')
  );
  if (options.bundledDefaultSuppressedBy) {
    print(
      uiText(
        `Note: the built-in model gateway is disabled because ${options.bundledDefaultSuppressedBy} already sets model settings — remove them (moss config unset provider|model|baseUrl) or add an API key.`,
        `说明：内置模型网关已关闭，因为 ${options.bundledDefaultSuppressedBy} 已经设置了模型 — 请去掉它们（moss config unset provider|model|baseUrl）或补上 API 密钥。`
      )
    );
  }
  print('');
  print(
    uiText(
      '  moss setup                                      # interactive: provider + model + key',
      '  moss setup                                      # 交互：提供方 + 模型 + 密钥'
    )
  );
  print(
    uiText(
      '  moss config set provider <p> && moss config set model <m>   # script path (no TTY)',
      '  moss config set provider <p> && moss config set model <m>   # 脚本路径（无 TTY）'
    )
  );
  print(
    uiText(
      '  # API key: prefer `moss setup` (hidden prompt) — `config set apiKey` stays in shell history.',
      '  # API 密钥：优先用 `moss setup`（隐藏输入）— `config set apiKey` 会留在 shell 历史里。'
    )
  );
  print('');
  print(
    interactive
      ? uiText('Run setup, then start `moss` again.', '先完成配置，再重新启动 `moss`。')
      : uiText('Configure a model, then retry your command.', '配置模型后再重试这条命令。')
  );
}

export async function offerSetupForInteractiveMissingConfig(
  options: { bundledDefaultSuppressedBy?: string } = {}
): Promise<boolean> {
  printMissingConfigGuidance(true, options);
  const answer = await question(uiText('Start setup now? [Y/n] ', '现在开始配置？[Y/n] '));
  if (!answer || /^y(es)?$/i.test(answer)) {
    await runSetupWizard();
    return true;
  }
  print(
    uiText(
      'Setup skipped. Run `moss setup` when you are ready.',
      '已跳过配置。准备好后运行 `moss setup`。'
    )
  );
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
    uiText('[moss] No model configured yet.', '[moss] 尚未配置模型。'),
    uiText(
      '  Run `moss setup` to configure one, or tell me: "help me add a model configuration."',
      '  运行 `moss setup` 进行配置，或告诉我：「帮我加上模型配置。」'
    ),
    uiText('  (This hint appears only once.)', '  （此提示只出现一次。）'),
  ].join('\n');
}
