/**
 * Classify a stdin chunk before it reaches the composer.
 *
 * Printable text and known keys are kept. Mouse, focus, and unrecognized CSI
 * sequences are dropped (and counted) so they cannot land in the draft.
 * A sequence split across two chunks stays in `carry` until it completes.
 */

export type KeyStreamEvent =
  | { kind: 'printable'; text: string }
  | { kind: 'key'; name: string }
  | { kind: 'mouse'; button: number; x: number; y: number; release: boolean; raw: string }
  | { kind: 'focus'; focused: boolean }
  | { kind: 'paste'; text: string }
  | { kind: 'unknown-csi'; raw: string };

export interface KeyStreamResult {
  events: KeyStreamEvent[];
  carry: string;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function isFinalCsi(byte: string): boolean {
  const code = byte.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function parseSgrMouse(body: string, final: string): KeyStreamEvent | undefined {
  const match = /^<(\d+);(\d+);(\d+)$/.exec(body);
  if (!match) return undefined;
  return {
    kind: 'mouse',
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    release: final === 'm',
    raw: `\x1b[${body}${final}`,
  };
}

function parseX10Mouse(raw: string): KeyStreamEvent | undefined {
  if (!raw.startsWith('\x1b[M') || raw.length < 6) return undefined;
  const button = raw.charCodeAt(3) - 32;
  const x = raw.charCodeAt(4) - 32;
  const y = raw.charCodeAt(5) - 32;
  return { kind: 'mouse', button, x, y, release: false, raw: raw.slice(0, 6) };
}

function namedKey(sequence: string): string | undefined {
  if (sequence === '\x1b[I') return undefined;
  if (sequence === '\x1b[O') return undefined;
  if (sequence === '\x1bOP' || sequence === '\x1b[11~') return 'f1';
  if (sequence === '\x1bOQ' || sequence === '\x1b[12~') return 'f2';
  if (sequence === '\x1bOR' || sequence === '\x1b[13~') return 'f3';
  if (sequence === '\x1bOS' || sequence === '\x1b[14~') return 'f4';
  if (sequence === '\x1b[15~') return 'f5';
  if (sequence === '\x1b[17~') return 'f6';
  if (sequence === '\x1b[18~') return 'f7';
  if (sequence === '\x1b[19~') return 'f8';
  if (sequence === '\x1b[20~') return 'f9';
  if (sequence === '\x1b[21~') return 'f10';
  if (sequence === '\x1b[23~') return 'f11';
  if (sequence === '\x1b[24~') return 'f12';
  return undefined;
}

/**
 * Split `carry + chunk` into events. Incomplete ESC sequences stay in `carry`
 * (capped so a hostile stream cannot grow it without bound).
 */
export function classifyKeyStream(chunk: string, carry = ''): KeyStreamResult {
  const events: KeyStreamEvent[] = [];
  let input = carry + chunk;
  let index = 0;
  const pushPrintable = (text: string): void => {
    if (!text) return;
    const last = events[events.length - 1];
    if (last && last.kind === 'printable') last.text += text;
    else events.push({ kind: 'printable', text });
  };

  while (index < input.length) {
    const esc = input.indexOf('\x1b', index);
    if (esc === -1) {
      pushPrintable(input.slice(index));
      input = '';
      break;
    }
    if (esc > index) pushPrintable(input.slice(index, esc));
    const rest = input.slice(esc);
    if (rest.startsWith(PASTE_START)) {
      const end = rest.indexOf(PASTE_END);
      if (end === -1) {
        input = rest;
        break;
      }
      events.push({ kind: 'paste', text: rest.slice(PASTE_START.length, end) });
      input = rest.slice(end + PASTE_END.length);
      index = 0;
      continue;
    }
    if (rest === '\x1b' || rest === '\x1b[') {
      input = rest;
      break;
    }
    if (rest.startsWith('\x1b[I')) {
      events.push({ kind: 'focus', focused: true });
      input = rest.slice(3);
      index = 0;
      continue;
    }
    if (rest.startsWith('\x1b[O') && (rest.length === 3 || !/[A-Z]/.test(rest[3] ?? ''))) {
      // Focus-out is ESC [ O. SS3 function keys are ESC O P (no '[').
      if (rest.startsWith('\x1b[O')) {
        events.push({ kind: 'focus', focused: false });
        input = rest.slice(3);
        index = 0;
        continue;
      }
    }
    const x10 = parseX10Mouse(rest);
    if (x10 && x10.kind === 'mouse') {
      events.push(x10);
      input = rest.slice(6);
      index = 0;
      continue;
    }
    if (rest.startsWith('\x1b[M') && rest.length < 6) {
      input = rest;
      break;
    }
    if (rest.startsWith('\x1b[')) {
      let end = 2;
      while (end < rest.length && !isFinalCsi(rest[end] ?? '')) end += 1;
      if (end >= rest.length) {
        input = rest.length > 64 ? '' : rest;
        if (rest.length > 64) events.push({ kind: 'unknown-csi', raw: rest.slice(0, 64) });
        break;
      }
      const sequence = rest.slice(0, end + 1);
      const body = rest.slice(2, end);
      const final = rest[end] ?? '';
      const mouse = final === 'M' || final === 'm' ? parseSgrMouse(body, final) : undefined;
      if (mouse) events.push(mouse);
      else {
        const name = namedKey(sequence);
        if (name) events.push({ kind: 'key', name });
        else if (sequence.startsWith('\x1b[200'))
          events.push({ kind: 'unknown-csi', raw: sequence });
        else events.push({ kind: 'unknown-csi', raw: sequence });
      }
      input = rest.slice(end + 1);
      index = 0;
      continue;
    }
    if (rest.startsWith('\x1bO')) {
      if (rest.length < 3) {
        input = rest;
        break;
      }
      const sequence = rest.slice(0, 3);
      const name = namedKey(sequence);
      if (name) events.push({ kind: 'key', name });
      else events.push({ kind: 'unknown-csi', raw: sequence });
      input = rest.slice(3);
      index = 0;
      continue;
    }
    events.push({ kind: 'unknown-csi', raw: rest.slice(0, 1) });
    input = rest.slice(1);
    index = 0;
  }

  return { events, carry: input.length > 128 ? '' : input };
}

/**
 * Ink sometimes hands an unrecognized CSI to `useInput` as text (the ESC may
 * already have been eaten). Those bytes must not become composer text.
 * Known keys (arrows, enter, ctrl) are decided by ink's key flags, not here.
 */
export function isComposerLeak(chunk: string): boolean {
  if (!chunk) return false;
  if (chunk.includes('\x1b')) {
    const { events, carry } = classifyKeyStream(chunk);
    const typed = events.some((event) => event.kind === 'printable' || event.kind === 'paste');
    if (typed) return false;
    const leaked = events.some(
      (event) => event.kind === 'mouse' || event.kind === 'focus' || event.kind === 'unknown-csi'
    );
    return leaked || carry.startsWith('\x1b');
  }
  return /^(?:\[<\d+;\d+;\d+[Mm]|\[200~|\[201~|\[I|\[O|\[(?:1[1-9]|2[0-4])~)+$/.test(chunk);
}

/** True when every event in the chunk must stay out of the composer. */
export function droppedKeyStream(chunk: string): KeyStreamEvent[] {
  const { events, carry } = classifyKeyStream(chunk);
  const dropped = events.filter(
    (event) => event.kind === 'mouse' || event.kind === 'focus' || event.kind === 'unknown-csi'
  );
  if (carry.startsWith('\x1b')) dropped.push({ kind: 'unknown-csi', raw: carry });
  return dropped;
}

let droppedCount = 0;

export function noteDroppedKeys(count: number): void {
  droppedCount += count;
}

export function droppedKeyCount(): number {
  return droppedCount;
}

export function resetDroppedKeyCount(): void {
  droppedCount = 0;
}
