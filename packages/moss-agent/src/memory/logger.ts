const PREFIX = '[memory]';

export function memoryWarn(msg: string, data?: unknown): void {
  if (data !== undefined) {
    console.warn(`${PREFIX} ${msg}`, data);
  } else {
    console.warn(`${PREFIX} ${msg}`);
  }
}

export function memoryInfo(msg: string): void {
  console.warn(`${PREFIX} ${msg}`);
}
