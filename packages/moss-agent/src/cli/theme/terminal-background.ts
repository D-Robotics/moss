












import type { CliThemeMode } from './theme.js';


const OSC11_REQUEST = '\x1b]11;?\x07';



const OSC11_RESPONSE = /\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i;






export function parseOsc11Background(data: string): { r: number; g: number; b: number } | null {
  const match = OSC11_RESPONSE.exec(data);
  if (!match) return null;
  const channel = (hex: string): number => {
    const max = 16 ** hex.length - 1;
    if (max === 0) return 0;
    return Math.round((Number.parseInt(hex, 16) / max) * 255);
  };
  return { r: channel(match[1]), g: channel(match[2]), b: channel(match[3]) };
}






export function terminalModeFromBackgroundRgb(r: number, g: number, b: number): CliThemeMode {
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma >= 0.5 ? 'light' : 'dark';
}

export interface DetectBackgroundOptions {
  timeoutMs?: number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}








export async function detectTerminalBackgroundMode(
  options: DetectBackgroundOptions = {}
): Promise<CliThemeMode | null> {
  const env = options.env ?? process.env;
  if (env.MOSS_NO_TERM_QUERY === '1' || env.NO_COLOR) return null;

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return null;

  return await new Promise<CliThemeMode | null>((resolve) => {
    let buffer = '';
    let settled = false;
    const wasRaw = stdin.isRaw;

    const finish = (mode: CliThemeMode | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        
      }
      if (!wasRaw) stdin.pause();
      resolve(mode);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      const rgb = parseOsc11Background(buffer);
      if (rgb) {
        finish(terminalModeFromBackgroundRgb(rgb.r, rgb.g, rgb.b));
      } else if (buffer.length > 256) {
        
        
        finish(null);
      }
    };

    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 120);

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      stdout.write(OSC11_REQUEST);
    } catch {
      finish(null);
    }
  });
}
