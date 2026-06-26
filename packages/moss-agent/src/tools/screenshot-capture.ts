/**
 * Screenshot capture tool — platform-aware screen capture via OS-native tools.
 *
 * Supports:
 *  - macOS: `screencapture` (built-in)
 *  - Linux: `gnome-screenshot`, `import` (ImageMagick), `grim` (wlroots), `scrot`
 *  - Windows: PowerShell `Add-Type -AssemblyName System.Drawing`
 *
 * Returns a base64 data URL ready for vision_analyze consumption.
 *
 * @public
 */
import { runProcess } from '../utils/run-process.js';
import type { Tool } from '../core/tools/tool-types.js';
import { errorMessage } from '../errors.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ScreenshotCaptureInput {
  /** Capture mode: 'full' for entire screen, 'window' for active window (when supported). */
  mode?: 'full' | 'window';
  /** Output format: 'png' (default) or 'jpg'. */
  format?: 'png' | 'jpg';
  /** Quality 1-100 for JPEG output (ignored for PNG). Default 80. */
  quality?: number;
}

const SCREENSHOT_TIMEOUT_MS = 10_000;

async function captureMacOS(mode: 'full' | 'window', outputPath: string, format: 'png' | 'jpg'): Promise<void> {
  const args: string[] = [mode === 'window' ? '-w' : '', '-t', format, '-x', outputPath].filter(Boolean) as string[];
  await runProcess('screencapture', { args, timeout: SCREENSHOT_TIMEOUT_MS });
}

async function captureLinux(outputPath: string): Promise<void> {
  // Try multiple tools in order of preference
  const tools = [
    { cmd: 'gnome-screenshot', args: ['-f', outputPath] },
    { cmd: 'import', args: ['-window', 'root', outputPath] }, // ImageMagick
    { cmd: 'grim', args: [outputPath] },                      // wlroots/Wayland
    { cmd: 'scrot', args: [outputPath] },
    { cmd: 'xwd', args: ['-root', '-out', outputPath] },     // X11 fallback
    { cmd: 'spectacle', args: ['-b', '-n', '-o', outputPath] }, // KDE
  ];

  for (const tool of tools) {
    try {
      await runProcess(tool.cmd, { args: tool.args, timeout: SCREENSHOT_TIMEOUT_MS });
      return; // Success
    } catch {
      continue; // Try next tool
    }
  }
  throw new Error(
    'No screenshot tool found. Install one: gnome-screenshot, imagemagick (import), grim (wlroots), or scrot.',
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

/**
 * Create a screenshot capture tool.
 *
 * @public
 */
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
          description: 'Capture mode: "full" for entire screen (default), "window" for active window.',
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
          `[screenshot_capture: captured ${mode} screen]`,
          `Format: ${format.toUpperCase()}`,
          `Size: ${stat.size} bytes`,
          `Data URL length: ${base64.length} chars`,
          ``,
          `To analyze this screenshot, pass the following data URL to vision_analyze:`,
          `(data URL is ${base64.length} chars — ready for vision_analyze input)`,
          ``,
          `Tip: use vision_analyze with image="${dataUrl.slice(0, 50)}..." to read the screenshot content.`,
        ].join('\n');
      } catch (err) {
        return `Error: screenshot capture failed: ${errorMessage(err)}`;
      } finally {
        // Clean up temp file
        try {
          await fs.unlink(tmpFile);
        } catch {
          // Best effort cleanup
        }
      }
    },
  };
}

/**
 * Default screenshot capture tool instance.
 *
 * @public
 */
export const screenshotCaptureTool: Tool<ScreenshotCaptureInput> = createScreenshotCaptureTool();
