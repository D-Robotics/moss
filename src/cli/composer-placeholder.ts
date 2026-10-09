/**
 * Empty-composer hint, chosen from what this workspace actually is.
 * A board session (device host or a saved device) keeps the camera prompt.
 * A code checkout gets a coding prompt. Anything else gets a neutral one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadDeviceRegistry } from '../device/device-registry-file.js';

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

export function detectComposerProjectKind(input: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): ComposerProjectKind {
  const env = input.env ?? process.env;
  if ((env.MOSS_DEVICE_HOST ?? '').trim()) return 'board';
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
