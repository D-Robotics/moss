/**
 * Ctrl+V attachment capture (backlog B01, the last promised-but-missing input
 * path): the help block has always advertised "attach clipboard image / Finder
 * file / path", but nothing read the clipboard.
 *
 * The image never becomes an inline base64 payload here. It is staged into the
 * gitignored `.moss/runtime/attachments/` and the composer receives an
 * `@<path>` mention — the model opens it with `read_image`, which already
 * enforces magic-byte checks, the 3 MB limit and the `agent.supportsImages`
 * guard. One attachment path, one budget, and the transcript keeps a short path
 * instead of a multi-megabyte blob.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_IMAGE_MAX_BYTES, detectImageMimeType } from '../tools/read-image-tool.js';
import { runProcess } from '../utils/run-process.js';
import { ensureMossRuntimeGitignore } from '../utils/workspace-paths.js';

const CLIPBOARD_TIMEOUT_MS = 4_000;

export type ClipboardCapture =
  | {
      kind: 'image';
      /** Workspace-relative path for the composer `@` mention. */
      relPath: string;
      absolutePath: string;
      bytes: number;
      mimeType: string;
    }
  | { kind: 'text'; text: string }
  | { kind: 'empty'; reason: string }
  | { kind: 'unsupported'; reason: string };

interface CommandOutcome {
  ok: boolean;
  stdout: string;
  reason?: string;
}

async function run(cmd: string, args: readonly string[]): Promise<CommandOutcome> {
  try {
    const result = await runProcess(cmd, {
      args: [...args],
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    if (result.exitCode !== 0) {
      return { ok: false, stdout: result.stdout, reason: result.stderr.trim() || undefined };
    }
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * `osascript -e 'get the clipboard as «class PNGf»'` prints the bytes as hex:
 * `«data PNGf89504E47…»`. Exported so the probe can pin the parser without a
 * clipboard.
 */
export function decodeAppleScriptImageData(text: string): Buffer | null {
  const match = /«data (?:PNGf|TIFF|JPEG)([0-9A-Fa-f\s]+)»/.exec(text);
  if (!match?.[1]) return null;
  const hex = match[1].replace(/\s+/g, '');
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

async function readClipboardImage(platform: NodeJS.Platform): Promise<Buffer | null> {
  if (platform === 'darwin') {
    const png = await run('osascript', ['-e', 'get the clipboard as «class PNGf»']);
    const fromPng = png.ok ? decodeAppleScriptImageData(png.stdout) : null;
    if (fromPng) return fromPng;
    const tiff = await run('osascript', ['-e', 'get the clipboard as «class TIFF»']);
    // TIFF is not one of read_image's formats; report no image rather than a
    // file the tool would reject.
    return tiff.ok ? null : null;
  }
  if (platform === 'linux') {
    const listing = await run('wl-paste', ['--list-types']);
    const target = path.join(os.tmpdir(), `moss-clip-${crypto.randomUUID()}.png`);
    if (listing.ok && /image\/(png|jpeg|webp|gif)/.test(listing.stdout)) {
      const saved = await run('sh', [
        '-c',
        'wl-paste --type image/png > "$1"',
        'moss-clipboard',
        target,
      ]);
      if (saved.ok) {
        const bytes = await readIfExists(target);
        if (bytes) return bytes;
      }
    }
    const xclip = await run('sh', [
      '-c',
      'xclip -selection clipboard -t image/png -o > "$1"',
      'moss-clipboard',
      target,
    ]);
    if (!xclip.ok) return null;
    return readIfExists(target);
  }
  if (platform === 'win32') {
    const target = path.join(os.tmpdir(), `moss-clip-${crypto.randomUUID()}.png`);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$img=[System.Windows.Forms.Clipboard]::GetImage();',
      `if ($img -ne $null) { $img.Save('${target.replace(/\\/g, '\\\\')}'); 'SAVED' }`,
    ].join(' ');
    const saved = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (!saved.ok || !saved.stdout.includes('SAVED')) return null;
    return readIfExists(target);
  }
  return null;
}

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}

async function readClipboardText(platform: NodeJS.Platform): Promise<string | null> {
  const cmd = platform === 'darwin' ? 'pbpaste' : platform === 'linux' ? 'wl-paste' : 'powershell';
  const args =
    platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']
      : platform === 'linux'
        ? ['--no-newline']
        : [];
  const result = await run(cmd, args);
  if (!result.ok) return null;
  return result.stdout;
}

/**
 * A Finder "Copy" puts a `«class furl»` file URL on the clipboard and no text
 * and no image bytes, so the drag-a-file path needs its own read. `POSIX path
 * of` is the one AppleScript coercion that returns a usable path.
 */
async function readClipboardFilePath(platform: NodeJS.Platform): Promise<string | null> {
  if (platform !== 'darwin') return null;
  const result = await run('osascript', [
    '-e',
    'get POSIX path of (the clipboard as «class furl»)',
  ]);
  if (!result.ok) return null;
  const candidate = result.stdout.trim();
  return candidate.length > 0 ? candidate : null;
}

/**
 * Text that is really a file reference: a `file://` URL from a browser "copy
 * link", or a path a terminal inserts when a file is dragged onto it (spaces
 * arrive backslash-escaped, and the whole thing may be quoted).
 */
export function clipboardPathFromText(text: string): string | null {
  let value = text.trim();
  if (value.length === 0 || value.includes('\n')) return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  // Windows paths keep their separators; only POSIX paths get the terminal's
  // backslash-escaped forms undone (drag-and-drop escapes spaces as `\ `).
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  if (value.startsWith('/') || value.startsWith('~/')) {
    const unescaped = value.replace(/\\ /g, ' ');
    if (unescaped.startsWith('~/')) return path.join(os.homedir(), unescaped.slice(2));
    return unescaped;
  }
  return null;
}

/**
 * Linux has no built-in clipboard: images and text both go through `wl-paste`
 * (Wayland) or `xclip` (X11). When neither binary exists, "clipboard has no
 * image, file or text" is the wrong diagnosis — installing a clipboard tool is
 * the fix, so name it instead of leaving the user to guess.
 */
async function missingLinuxClipboardTool(): Promise<boolean> {
  const has = async (tool: string): Promise<boolean> => {
    const result = await run('sh', ['-c', `command -v ${tool} >/dev/null 2>&1`]);
    return result.ok;
  };
  if (await has('wl-paste')) return false;
  if (await has('xclip')) return false;
  return true;
}

/** Stage an existing image file (Finder copy / dragged path) under the same
 *  content-addressed budget as a clipboard screenshot. */
export async function stageClipboardFile(options: {
  workspaceDir: string;
  filePath: string;
}): Promise<
  | { ok: true; relPath: string; absolutePath: string; bytes: number; mimeType: string }
  | { ok: false; reason: string }
> {
  let stats;
  try {
    stats = await fs.stat(options.filePath);
  } catch {
    return { ok: false, reason: 'clipboard file does not exist' };
  }
  if (!stats.isFile()) return { ok: false, reason: 'clipboard file reference is not a file' };
  if (stats.size > READ_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      reason: `clipboard file is ${stats.size} bytes, over the ${READ_IMAGE_MAX_BYTES} B read_image limit`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(options.filePath);
  } catch {
    return { ok: false, reason: 'clipboard file could not be read' };
  }
  const detected = detectImageMimeType(bytes);
  if (!detected) return { ok: false, reason: 'clipboard file is not a PNG/JPEG/GIF/WebP image' };
  const staged = await stageClipboardImage({
    workspaceDir: options.workspaceDir,
    bytes,
    mimeType: detected.mimeType,
  });
  if (!staged.ok) return staged;
  return { ...staged, bytes: bytes.length, mimeType: detected.mimeType };
}

/**
 * Content-addressed staging. Two pastes of the same screenshot share one file,
 * and nothing outside `.moss/runtime/` ever holds a copy.
 */
export async function stageClipboardImage(options: {
  workspaceDir: string;
  bytes: Buffer;
  mimeType: string;
}): Promise<{ ok: true; relPath: string; absolutePath: string } | { ok: false; reason: string }> {
  const { workspaceDir, bytes, mimeType } = options;
  if (bytes.length === 0) return { ok: false, reason: 'clipboard image is empty' };
  if (bytes.length > READ_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      reason: `clipboard image is ${bytes.length} bytes, over the ${READ_IMAGE_MAX_BYTES} B read_image limit`,
    };
  }
  const detected = detectImageMimeType(bytes);
  if (!detected || detected.mimeType !== mimeType) {
    return { ok: false, reason: 'clipboard bytes are not a PNG/JPEG/GIF/WebP image' };
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const dir = path.join(workspaceDir, '.moss', 'runtime', 'attachments');
  const absolutePath = path.join(dir, `${digest}${detected.extension}`);
  ensureMossRuntimeGitignore(workspaceDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(absolutePath, bytes, { mode: 0o600 });
  const relPath = path.relative(workspaceDir, absolutePath).split(path.sep).join('/');
  return { ok: true, relPath, absolutePath };
}

/**
 * Read the clipboard once: an image is staged and returned as a path mention;
 * plain text is returned for insertion; the empty/unsupported cases explain
 * themselves instead of silently doing nothing.
 */
export async function captureClipboardAttachment(options: {
  workspaceDir: string;
  platform?: NodeJS.Platform;
}): Promise<ClipboardCapture> {
  const platform = options.platform ?? process.platform;
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    return { kind: 'unsupported', reason: `clipboard capture is not implemented on ${platform}` };
  }
  const image = await readClipboardImage(platform);
  if (image) {
    const detected = detectImageMimeType(image);
    if (!detected) {
      return { kind: 'empty', reason: 'clipboard image is in a format read_image cannot open' };
    }
    const staged = await stageClipboardImage({
      workspaceDir: options.workspaceDir,
      bytes: image,
      mimeType: detected.mimeType,
    });
    if (!staged.ok) return { kind: 'empty', reason: staged.reason };
    return {
      kind: 'image',
      relPath: staged.relPath,
      absolutePath: staged.absolutePath,
      bytes: image.length,
      mimeType: detected.mimeType,
    };
  }
  // A Finder file copy has a file URL but no image bytes and no text: attach it
  // as an image mention instead of reporting an empty clipboard.
  const filePath = (await readClipboardFilePath(platform)) ?? null;
  if (filePath) {
    const stagedFile = await stageClipboardFile({ workspaceDir: options.workspaceDir, filePath });
    if (stagedFile.ok) {
      return {
        kind: 'image',
        relPath: stagedFile.relPath,
        absolutePath: stagedFile.absolutePath,
        bytes: stagedFile.bytes,
        mimeType: stagedFile.mimeType,
      };
    }
  }
  const text = (await readClipboardText(platform)) ?? '';
  if (text.trim().length > 0) {
    // A dragged/browser-copied file arrives as text; same treatment as Finder.
    const fromText = clipboardPathFromText(text);
    if (fromText) {
      const stagedText = await stageClipboardFile({
        workspaceDir: options.workspaceDir,
        filePath: fromText,
      });
      if (stagedText.ok) {
        return {
          kind: 'image',
          relPath: stagedText.relPath,
          absolutePath: stagedText.absolutePath,
          bytes: stagedText.bytes,
          mimeType: stagedText.mimeType,
        };
      }
    }
    return { kind: 'text', text };
  }
  if (platform === 'linux' && (await missingLinuxClipboardTool())) {
    return {
      kind: 'empty',
      reason:
        'no clipboard tool found — install wl-clipboard (wl-paste) or xclip to paste on Linux',
    };
  }
  return { kind: 'empty', reason: 'clipboard has no image, file or text' };
}

/** The mention inserted into the composer; `@` is Moss's file-reference form. */
export function formatAttachmentMention(relPath: string): string {
  return `@${relPath}`;
}
