/** Avoid terminal-size subprocess probes for custom non-TTY output sinks. */
export function installNonTtyOutputDimensions(stdout: {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
}): (() => void) | undefined {
  if (stdout === process.stdout || stdout.isTTY === true) return undefined;
  const cleanups: Array<() => void> = [];
  for (const [key, fallback] of [
    ['columns', 80],
    ['rows', 24],
  ] as const) {
    try {
      if (Number.isFinite(stdout[key]) && (stdout[key] ?? 0) > 0) continue;
      const previous = Object.getOwnPropertyDescriptor(stdout, key);
      let effective = previous;
      for (
        let prototype = Object.getPrototypeOf(stdout);
        !effective && prototype;
        prototype = Object.getPrototypeOf(prototype)
      ) {
        effective = Object.getOwnPropertyDescriptor(prototype, key);
      }
      if (
        (previous && !previous.configurable) ||
        (effective && (effective.writable === false || 'get' in effective || 'set' in effective))
      )
        continue;
      const get = (): number => fallback;
      const set = (value: number): void => {
        Object.defineProperty(stdout, key, {
          value,
          writable: true,
          enumerable: previous?.enumerable ?? false,
          configurable: true,
        });
      };
      Object.defineProperty(stdout, key, {
        get,
        set,
        configurable: true,
        enumerable: previous?.enumerable ?? false,
      });
      cleanups.push(() => {
        const current = Object.getOwnPropertyDescriptor(stdout, key);
        if (current?.get !== get || current.set !== set) return;
        if (previous) Object.defineProperty(stdout, key, previous);
        else Reflect.deleteProperty(stdout, key);
      });
    } catch {
      // Read-only or non-extensible host streams keep their own dimensions.
    }
  }
  if (cleanups.length === 0) return undefined;
  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // The host may have sealed the stream after mounting.
      }
    }
  };
}
