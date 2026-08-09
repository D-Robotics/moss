import { runProcess } from '../utils/run-process.js';
import type { Tool } from '../core/tools/tool-types.js';
import { errorMessage } from '../errors.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ScreenshotCaptureInput {
  mode?: 'full' | 'window';

  format?: 'png' | 'jpg';

  quality?: number;
}

const SCREENSHOT_TIMEOUT_MS = 10_000;

async function captureMacOS(
  mode: 'full' | 'window',
  outputPath: string,
  format: 'png' | 'jpg'
): Promise<void> {
  const args: string[] = [mode === 'window' ? '-w' : '', '-t', format, '-x', outputPath].filter(
    Boolean
  ) as string[];
  try {
    await runProcess('screencapture', { args, timeout: SCREENSHOT_TIMEOUT_MS });
  } catch (err) {
    throw new Error(
      `screencapture failed: ${errorMessage(err)}. ` +
        'Try granting Terminal permissions in System Settings > Security & Privacy > Screen Recording.'
    );
  }
}

async function captureLinux(outputPath: string): Promise<void> {
  const tools = [
    { cmd: 'gnome-screenshot', args: ['-f', outputPath] },
    { cmd: 'import', args: ['-window', 'root', outputPath] },
    { cmd: 'grim', args: [outputPath] },
    { cmd: 'scrot', args: [outputPath] },
    { cmd: 'xwd', args: ['-root', '-out', outputPath] },
    { cmd: 'spectacle', args: ['-b', '-n', '-o', outputPath] },
  ];

  const failures: string[] = [];
  for (const tool of tools) {
    try {
      await runProcess(tool.cmd, { args: tool.args, timeout: SCREENSHOT_TIMEOUT_MS });
      return;
    } catch (err) {
      const reason = errorMessage(err);
      if (reason.includes('not found') || reason.includes('ENOENT')) {
        failures.push(`  • ${tool.cmd}: not installed`);
      } else if (tool.cmd === 'grim' || tool.cmd === 'scrot') {
        failures.push(`  • ${tool.cmd}: X11 or Wayland required or not available`);
      } else {
        failures.push(`  • ${tool.cmd}: ${reason}`);
      }
    }
  }
  throw new Error(
    'No screenshot tool found. Tried:\n' +
      failures.join('\n') +
      '\n\nInstall one:\n' +
      '  • Ubuntu/Debian: sudo apt-get install gnome-screenshot imagemagick grim scrot\n' +
      '  • Fedora: sudo dnf install gnome-screenshot ImageMagick grim scrot\n' +
      '  • Arch: sudo pacman -S gnome-screenshot imagemagick grim scrot\n' +
      '  • Or set MOSS_SCREENSHOT_CMD to your preferred tool.'
  );
}

async function captureWindows(outputPath: string): Promise<void> {
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
    $bitmap.Save('${outputPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
  `;
  await runProcess('powershell', {
    args: ['-NoProfile', '-Command', psScript],
    timeout: SCREENSHOT_TIMEOUT_MS,
  });
}

export function createScreenshotCaptureTool(): Tool<ScreenshotCaptureInput> {
  return {
    name: 'screenshot_capture',
    description:
      'Capture a screenshot of the current desktop or active window. ' +
      'Returns a base64-encoded image that can be passed to vision_analyze for visual inspection. ' +
      'Works on macOS (built-in screencapture), Linux (gnome-screenshot/import/grim/scrot), ' +
      'and Windows (PowerShell).',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['full', 'window'],
          description:
            'Capture mode: "full" for entire screen (default), "window" for active window.',
        },
        format: {
          type: 'string',
          enum: ['png', 'jpg'],
          description: 'Output format: "png" (default, lossless) or "jpg" (compressed).',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (ignored for PNG). Default 80.',
        },
      },
    },
    async execute(input) {
      const mode = input.mode ?? 'full';
      const format = input.format ?? 'png';
      const ext = format === 'jpg' ? '.jpg' : '.png';
      const tmpDir = os.tmpdir();
      const tmpFile = path.join(tmpDir, `moss-screenshot-${Date.now()}${ext}`);

      try {
        if (process.platform === 'darwin') {
          await captureMacOS(mode, tmpFile, format);
        } else if (process.platform === 'win32') {
          await captureWindows(tmpFile);
        } else {
          await captureLinux(tmpFile);
        }

        const stat = await fs.stat(tmpFile);
        if (stat.size === 0) {
          return 'Error: screenshot capture produced an empty file. Try a different mode or tool.';
        }

        const buffer = await fs.readFile(tmpFile);
        const base64 = buffer.toString('base64');
        const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
        const dataUrl = `data:${mimeType};base64,${base64}`;

        return [
          `[screenshot_capture_ok]`,
          `📷 Captured: ${mode === 'full' ? 'full screen' : 'active window'}`,
          `├─ Format: ${format.toUpperCase()}`,
          `├─ Size: ${stat.size} bytes`,
          `├─ Encoded: ${base64.length} characters`,
          `└─ Data URL ready for vision_analyze`,
          ``,
          `Next: Pass this data URL to vision_analyze to analyze the screenshot:`,
          `  image="${dataUrl}"`,
          `  question="What do you see in this screenshot?"`,
        ].join('\n');
      } catch (err) {
        return `Error: screenshot capture failed: ${errorMessage(err)}`;
      } finally {
        try {
          await fs.unlink(tmpFile);
        } catch {}
      }
    },
  };
}

export const screenshotCaptureTool: Tool<ScreenshotCaptureInput> = createScreenshotCaptureTool();
