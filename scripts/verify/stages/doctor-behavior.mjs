/**
 * Doctor reports the switches a user cannot otherwise see.
 *
 * `moss config show` lists images / review mode / verification gate, but the
 * diagnostic view a stuck user opens must not disagree with it — before this the
 * behavior block was missing entirely, so `moss doctor` never answered "why did my
 * screenshot get rejected" or "why did review run". This stage runs the real
 * `moss doctor` in a temp HOME with two of the three switches flipped and asserts
 * the rendered lines (auth failure in the temp HOME is expected there).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

const EXPECTED = [
  'images: text-only (agent.supportsImages=false) (user)',
  'review mode: auto (config or env)',
  'verification gate: off (env)',
];

export const stage = {
  name: 'doctor-behavior',
  requires: ['build'],
  description: 'moss doctor reports images / review mode / verification gate',
  async run(context) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-doctor-'));
    const configDir = path.join(home, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        provider: 'openai-compatible',
        model: 'm',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test',
        agent: { supportsImages: false },
        review: { mode: 'auto' },
        permissions: { defaultMode: 'full' },
      })
    );
    const started = Date.now();
    try {
      const result = await captureProcess(
        process.execPath,
        [path.join(context.root, 'dist', 'cli.js'), 'doctor'],
        {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            MOSS_CONFIG_DIR: configDir,
            MOSS_NO_RDK_DOCS: '1',
            MOSS_VERIFICATION_GATE: '0',
            MOSS_LANG: 'en',
          },
          timeoutMs: 90_000,
        }
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const missing = EXPECTED.filter((line) => !output.includes(line));
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `moss doctor missing: ${missing.join(' | ')}`,
        };
      }
      console.log(
        `[doctor-behavior] behavior block rendered in ${formatDuration(Date.now() - started)}`
      );
      return { ok: true };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
};
