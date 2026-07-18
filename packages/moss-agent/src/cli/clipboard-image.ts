import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { preparePromptAttachments, type PreparePromptAttachmentsResult } from './attachments.js';

const APPLESCRIPT_SAVE_PNG = `
on run argv
  set outPath to item 1 of argv
  try
    set pngData to the clipboard as «class PNGf»
  on error
    error "clipboard does not contain a PNG image"
  end try
  set outFile to open for access (POSIX file outPath) with write permission
  try
    set eof outFile to 0
    write pngData to outFile
  on error errMsg number errNum
    try
      close access outFile
    end try
    error errMsg number errNum
  end try
  close access outFile
end run
`.trim();

const APPLESCRIPT_READ_CLIPBOARD_PATHS = `
on appendPath(outList, itemValue)
  try
    set end of outList to POSIX path of (itemValue as alias)
  end try
  return outList
end appendPath

on run
  set out to {}
  try
    set fileItems to the clipboard as «class furl»
    if class of fileItems is list then
      repeat with f in fileItems
        set out to appendPath(out, f)
      end repeat
    else
      set out to appendPath(out, fileItems)
    end if
  end try

  if (count of out) > 0 then
    set AppleScript's text item delimiters to linefeed
    return out as text
  end if

  try
    return the clipboard as text
  on error
    return ""
  end try
end run
`.trim();

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function execFile(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile(process.platform === 'win32' ? 'where' : 'which', [command], 2000);
    return true;
  } catch {
    return false;
  }
}

async function saveClipboardImageLinux(destPath: string): Promise<void> {
  // Prefer Wayland (wl-paste) then X11 (xclip). Both write raw PNG bytes to dest.
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'wl-paste', args: ['--type', 'image/png'] },
    { cmd: 'wl-paste', args: ['-t', 'image/png'] },
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] },
  ];
  let lastErr: Error | null = null;
  for (const attempt of attempts) {
    if (!(await commandExists(attempt.cmd))) continue;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(attempt.cmd, attempt.args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let stderr = '';
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${attempt.cmd} timed out`));
        }, 5000);
        timeout.unref?.();
        child.stdout?.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(stderr.trim() || `${attempt.cmd} exited ${code}`));
            return;
          }
          const buf = Buffer.concat(chunks);
          if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
            reject(new Error('clipboard does not contain a PNG image'));
            return;
          }
          try {
            fs.writeFileSync(destPath, buf, { mode: 0o600 });
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error(
    'clipboard image paste needs wl-paste (Wayland) or xclip (X11) on Linux',
  );
}

async function saveClipboardImageWindows(destPath: string): Promise<void> {
  // PowerShell: save clipboard bitmap as PNG via System.Windows.Forms.
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$img = [System.Windows.Forms.Clipboard]::GetImage();',
    'if ($null -eq $img) { throw "clipboard does not contain an image" };',
    `$img.Save('${destPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
  ].join(' ');
  await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 8000);
}

export async function saveClipboardImageToFile(destPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFile('osascript', ['-e', APPLESCRIPT_SAVE_PNG, destPath], 5000);
    return;
  }
  if (process.platform === 'linux') {
    await saveClipboardImageLinux(destPath);
    return;
  }
  if (process.platform === 'win32') {
    await saveClipboardImageWindows(destPath);
    return;
  }
  throw new Error(`clipboard image paste is not supported on ${process.platform}`);
}

async function readClipboardPathsLinux(): Promise<string[]> {
  // Prefer text paths from clipboard (user copied a path or file URI).
  const textAttempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'wl-paste', args: ['--type', 'text/plain'] },
    { cmd: 'wl-paste', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    { cmd: 'xsel', args: ['--clipboard', '--output'] },
  ];
  for (const attempt of textAttempts) {
    if (!(await commandExists(attempt.cmd))) continue;
    try {
      const output = await execFile(attempt.cmd, attempt.args, 3000);
      const paths = output
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^file:\/\//, ''))
        .filter((line) => line.length > 0 && (line.startsWith('/') || /^[A-Za-z]:[\\/]/.test(line)));
      if (paths.length > 0) return paths;
    } catch {
      // try next backend
    }
  }
  return [];
}

async function readClipboardPathsWindows(): Promise<string[]> {
  const ps = [
    '$paths = @();',
    'if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
    '  $paths = [System.Windows.Forms.Clipboard]::GetFileDropList();',
    '} elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {',
    '  $t = [System.Windows.Forms.Clipboard]::GetText();',
    '  if ($t -match "^[A-Za-z]:\\\\|^\\\\\\\\") { $paths = @($t.Trim()) }',
    '}',
    '$paths -join "`n"',
  ].join(' ');
  try {
    const output = await execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; ' + ps,
      ],
      5000,
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function readClipboardAttachmentPaths(): Promise<string[]> {
  if (process.platform === 'darwin') {
    const output = await execFile('osascript', ['-e', APPLESCRIPT_READ_CLIPBOARD_PATHS], 5000);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (process.platform === 'linux') {
    return readClipboardPathsLinux();
  }
  if (process.platform === 'win32') {
    return readClipboardPathsWindows();
  }
  throw new Error(`clipboard file paste is not supported on ${process.platform}`);
}

export async function prepareClipboardAttachment(options: {
  runtimeDir: string;
  cwd: string;
  startIndex?: number;
  saveClipboardImage?: (destPath: string) => Promise<void>;
  readClipboardPaths?: () => Promise<string[]>;
}): Promise<PreparePromptAttachmentsResult> {
  const dir = path.join(options.runtimeDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destPath = path.join(dir, `clipboard-${timestampForFilename()}.png`);

  try {
    await (options.saveClipboardImage ?? saveClipboardImageToFile)(destPath);
    const prepared = preparePromptAttachments([destPath], {
      cwd: options.cwd,
      startIndex: options.startIndex,
    });
    if (prepared.attachments.length > 0) return prepared;
  } catch {
    
  }

  try {
    try {
      fs.rmSync(destPath, { force: true });
    } catch {
      
    }
    const paths = await (options.readClipboardPaths ?? readClipboardAttachmentPaths)();
    if (paths.length > 0) {
      return preparePromptAttachments(paths, {
        cwd: options.cwd,
        startIndex: options.startIndex,
      });
    }
  } catch {
    
  }

  throw new Error('clipboard does not contain a supported image, file, or file path');
}

export async function prepareClipboardImageAttachment(options: {
  runtimeDir: string;
  cwd: string;
  startIndex?: number;
  saveClipboardImage?: (destPath: string) => Promise<void>;
}): Promise<PreparePromptAttachmentsResult> {
  return prepareClipboardAttachment(options);
}
