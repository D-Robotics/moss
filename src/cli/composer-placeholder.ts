/**
 * Empty-composer hint, chosen from what this workspace actually is.
 * A board session (device host or a saved device) keeps the camera prompt.
 * A code checkout gets a coding prompt. Anything else gets a neutral one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadDeviceRegistry } from '../device/device-registry-file.js';
import { dotenvOriginOf } from '../utils/startup-env.js';

export const BOARD_COMPOSER_PLACEHOLDER = 'Try "stream the camera at 30 fps and verify it"';
export const CODE_COMPOSER_PLACEHOLDER = 'Try "fix the failing test and explain the change"';
export const GENERAL_COMPOSER_PLACEHOLDER = 'Try "look around and tell me what this folder is"';

export type ComposerProjectKind = 'board' | 'code' | 'general';

const CODE_MARKERS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
  'Makefile',
] as const;

export function composerPlaceholder(kind: ComposerProjectKind): string {
  if (kind === 'board') return BOARD_COMPOSER_PLACEHOLDER;
  if (kind === 'code') return CODE_COMPOSER_PLACEHOLDER;
  return GENERAL_COMPOSER_PLACEHOLDER;
}

/**
 * A device host only makes this workspace a board when it comes from this
 * project (its own `.env` or an ancestor's) or from the real process env. A
 * checkout's `.env` used to leak its board into every workspace, so an
 * unrelated folder offered "stream the camera" as the first hint (B191).
 */
function envFileAppliesToWorkspace(file: string, workspaceDir: string): boolean {
  const dir = path.resolve(path.dirname(file));
  const workspace = path.resolve(workspaceDir);
  return workspace === dir || workspace.startsWith(dir + path.sep);
}

export function detectComposerProjectKind(input: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): ComposerProjectKind {
  const env = input.env ?? process.env;
  const deviceHost = (env.MOSS_DEVICE_HOST ?? '').trim();
  if (deviceHost) {
    const origin = dotenvOriginOf('MOSS_DEVICE_HOST');
    if (!origin || envFileAppliesToWorkspace(origin.file, input.workspaceDir)) return 'board';
  }
  try {
    if (loadDeviceRegistry(input.workspaceDir).length > 0) return 'board';
  } catch {
    /* an unreadable registry is not a board project */
  }
  for (const name of CODE_MARKERS) {
    try {
      if (fs.existsSync(path.join(input.workspaceDir, name))) return 'code';
    } catch {
      /* ignore a marker we cannot stat */
    }
  }
  return 'general';
}
