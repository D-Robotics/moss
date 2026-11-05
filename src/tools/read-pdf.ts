/**
 * read_pdf: extract the text layer of a local PDF with node builtins only.
 *
 * RDK field work produces PDFs (site reports, datasheets, vendor manuals) that
 * were previously unreadable to the model: `read_file` reports them as binary
 * and `read_image` only takes raster images. This tool scans the object graph,
 * inflates FlateDecode content streams, walks the page tree and replays the
 * text operators (`Tj` / `TJ` / `'` / `"`), turning `Td` / `TD` / `T*` / `ET`
 * into line breaks and decoding literal/hex strings with WinAnsi escapes.
 *
 * Deliberately not a full PDF reader: no OCR, no LZW/JPEG/JPX streams, and no
 * embedded-font program parsing. Text decoding prefers each font's `/ToUnicode`
 * CMap (how Word/browser/InDesign exports carry their real characters) and
 * falls back to the WinAnsi byte assumption for simple fonts without one.
 * Unsupported cases are reported honestly (and partial text is returned
 * best-effort) instead of crashing the tool or inventing content.
 */
import fs from 'node:fs/promises';
import { inflateRawSync, inflateSync } from 'node:zlib';
import type { StructuredToolResult, Tool, ToolContext } from '../core/tools/tool-types.js';
import { resolveReadPath } from '../safety/read-scope.js';

/** Largest PDF `read_pdf` loads. Bigger files are split or page-extracted first. */
export const READ_PDF_MAX_BYTES = 32 * 1024 * 1024;

/** Hostile-input guards: a PDF is a program, so every loop and buffer has a ceiling. */
const MAX_OBJECTS = 50_000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 2_000;
const MAX_TEXT_CHARS = 4_000_000;
const MAX_TOKEN_CHARS = 1_000_000;
const MAX_OPERANDS = 4_096;
const TJ_WORD_GAP = -150;

/**
 * CP1252 / WinAnsi for 0x80–0x9F; bytes 0xA0–0xFF are identical to Latin-1.
 * Reports and datasheets use these positions for quotes, dashes and bullets,
 * and rendering them as Latin-1 control characters would corrupt the text.
 */
const WIN_ANSI_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function latin1String(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

function isWhitespaceCode(code: number): boolean {
  return (
    code === 0x00 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20
  );
}

function isDelimiterCode(code: number): boolean {
  return (
    code === 0x28 || // (
    code === 0x29 || // )
    code === 0x3c || // <
    code === 0x3e || // >
    code === 0x5b || // [
    code === 0x5d || // ]
    code === 0x7b || // {
    code === 0x7d || // }
    code === 0x2f || // /
    code === 0x25 // %
  );
}

function isWhitespaceOrDelimiter(code: number): boolean {
  return isWhitespaceCode(code) || isDelimiterCode(code);
}

function isNumberStart(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return code - 0x61 + 10;
}

/** WinAnsi (CP1252) byte string → JavaScript text. */
function decodeWinAnsi(bytes: ArrayLike<number>): string {
  const chunk: number[] = [];
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const mapped = byte >= 0x80 && byte <= 0x9f ? (WIN_ANSI_HIGH[byte - 0x80] ?? byte) : byte;
    chunk.push(mapped);
    if (chunk.length >= 4_096) {
      text += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) text += String.fromCharCode(...chunk);
  return text;
}

function decodeUtf16(bytes: ArrayLike<number>, bigEndian: boolean): string {
  const units: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    units.push(bigEndian ? (first << 8) | second : (second << 8) | first);
  }
  let text = '';
  for (let index = 0; index < units.length; index += 4_096) {
    text += String.fromCharCode(...units.slice(index, index + 4_096));
  }
  return text;
}

/**
 * Hex strings in PDFs are either a PDFDocEncoding/WinAnsi byte string or, when
 * they carry a UTF-16 BOM, UTF-16. The BOM is the only reliable signal; a
 * Type0/Identity-H font without one still yields glyph IDs (see limitations).
 */
function decodeHexBytes(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16(bytes.slice(2), true);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16(bytes.slice(2), false);
  }
  return decodeWinAnsi(bytes);
}

// ── Content-stream tokenizer ────────────────────────────────────────────────

type StringToken = { kind: 'string'; bytes: number[]; hex: boolean };

type ContentToken =
  | StringToken
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'array'; value: ContentToken[] }
  | { kind: 'dict'; source: string };

function readLiteralString(source: string, start: number): { bytes: number[]; next: number } {
  const bytes: number[] = [];
  let depth = 1;
  let index = start + 1;
  while (index < source.length && bytes.length < MAX_TOKEN_CHARS) {
    const code = source.charCodeAt(index);
    if (code === 0x5c) {
      // backslash escape
      index += 1;
      if (index >= source.length) break;
      const escape = source.charCodeAt(index);
      index += 1;
      if (escape === 0x6e) bytes.push(0x0a);
      else if (escape === 0x72) bytes.push(0x0d);
      else if (escape === 0x74) bytes.push(0x09);
      else if (escape === 0x62) bytes.push(0x08);
      else if (escape === 0x66) bytes.push(0x0c);
      else if (escape === 0x28) bytes.push(0x28);
      else if (escape === 0x29) bytes.push(0x29);
      else if (escape === 0x5c) bytes.push(0x5c);
      else if (escape === 0x0d) {
        // line continuation inside a literal string
        if (source.charCodeAt(index) === 0x0a) index += 1;
      } else if (escape === 0x0a) {
        // line continuation
      } else if (escape >= 0x30 && escape <= 0x37) {
        let value = escape - 0x30;
        for (let extra = 0; extra < 2; extra += 1) {
          const digit = source.charCodeAt(index);
          if (digit >= 0x30 && digit <= 0x37) {
            value = value * 8 + (digit - 0x30);
            index += 1;
          } else break;
        }
        bytes.push(value & 0xff);
      } else {
        bytes.push(escape & 0xff);
      }
      continue;
    }
    if (code === 0x28) {
      depth += 1;
      bytes.push(code);
      index += 1;
      continue;
    }
    if (code === 0x29) {
      depth -= 1;
      index += 1;
      if (depth === 0) return { bytes, next: index };
      bytes.push(0x29);
      continue;
    }
    if (code === 0x0d) {
      // PDF text strings: CR and CRLF are single line breaks
      bytes.push(0x0a);
      index += 1;
      if (source.charCodeAt(index) === 0x0a) index += 1;
      continue;
    }
    bytes.push(code & 0xff);
    index += 1;
  }
  return { bytes, next: index };
}

function readHexString(source: string, start: number): { bytes: number[]; next: number } {
  const digits: number[] = [];
  let index = start + 1;
  while (index < source.length && digits.length < MAX_TOKEN_CHARS) {
    const code = source.charCodeAt(index);
    index += 1;
    if (code === 0x3e) break;
    if (isHexDigit(code)) digits.push(hexValue(code));
    else if (!isWhitespaceCode(code)) {
      // Not a hex digit: keep scanning for the closing `>` (best effort).
    }
  }
  if (digits.length % 2 === 1) digits.push(0);
  const bytes: number[] = [];
  for (let position = 0; position < digits.length; position += 2) {
    bytes.push(((digits[position] ?? 0) << 4) | (digits[position + 1] ?? 0));
  }
  return { bytes, next: index };
}

/** Scan a `<< … >>` dictionary starting at `from` and return its inner text. */
function readDictionary(text: string, from: number): { body: string; next: number } | null {
  let index = from;
  while (index < text.length && isWhitespaceCode(text.charCodeAt(index))) index += 1;
  if (text.charCodeAt(index) !== 0x3c || text.charCodeAt(index + 1) !== 0x3c) return null;
  index += 2;
  const start = index;
  let depth = 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x28) {
      // Skip string literals so a ">>" inside a title cannot close the dict early.
      index = readLiteralString(text, index).next;
      continue;
    }
    if (code === 0x3c && text.charCodeAt(index + 1) === 0x3c) {
      depth += 1;
      index += 2;
      continue;
    }
    if (code === 0x3e && text.charCodeAt(index + 1) === 0x3e) {
      depth -= 1;
      const end = index;
      index += 2;
      if (depth === 0) return { body: text.slice(start, end), next: index };
      continue;
    }
    index += 1;
  }
  return null;
}

function readName(source: string, start: number): { value: string; next: number } {
  let index = start + 1;
  while (index < source.length && !isWhitespaceOrDelimiter(source.charCodeAt(index))) index += 1;
  return { value: source.slice(start + 1, index), next: index };
}

function readNumber(source: string, start: number): { value: number; next: number } {
  let index = start;
  if (source.charCodeAt(index) === 0x2b || source.charCodeAt(index) === 0x2d) index += 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if ((code >= 0x30 && code <= 0x39) || code === 0x2e) index += 1;
    else break;
  }
  const value = Number.parseFloat(source.slice(start, index));
  return { value: Number.isFinite(value) ? value : 0, next: index };
}

function readOperator(source: string, start: number): { value: string; next: number } {
  const first = source.charCodeAt(start);
  // `'` and `"` are one-character text operators.
  if (first === 0x27 || first === 0x22) return { value: source.charAt(start), next: start + 1 };
  let index = start;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      index += 1;
      continue;
    }
    // `T*` is a letter followed by an asterisk; other operators are letters only.
    if (code === 0x2a && index > start) index += 1;
    break;
  }
  return { value: source.slice(start, index), next: index };
}

function skipInlineImage(source: string, from: number): number {
  const idAt = source.indexOf('ID', from);
  if (idAt === -1) return source.length;
  let cursor = idAt + 2;
  while (cursor + 1 < source.length) {
    const at = source.indexOf('EI', cursor);
    if (at === -1) return source.length;
    const after = source.charCodeAt(at + 2);
    if (isWhitespaceOrDelimiter(after) || at + 2 >= source.length) return at + 2;
    cursor = at + 2;
  }
  return source.length;
}

function readArray(
  source: string,
  start: number,
  depth: number
): { value: ContentToken[]; next: number } {
  const items: ContentToken[] = [];
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (isWhitespaceCode(code)) {
      index += 1;
      continue;
    }
    if (code === 0x25) {
      const endOfLine = source.indexOf('\n', index);
      index = endOfLine === -1 ? source.length : endOfLine + 1;
      continue;
    }
    if (code === 0x5d) return { value: items, next: index + 1 };
    if (code === 0x28) {
      const read = readLiteralString(source, index);
      index = read.next;
      if (items.length < MAX_OPERANDS) {
        items.push({ kind: 'string', bytes: read.bytes, hex: false });
      }
      continue;
    }
    if (code === 0x3c) {
      if (source.charCodeAt(index + 1) === 0x3c) {
        const end = source.indexOf('>>', index + 2);
        index = end === -1 ? source.length : end + 2;
        continue;
      }
      const read = readHexString(source, index);
      index = read.next;
      if (items.length < MAX_OPERANDS) {
        items.push({ kind: 'string', bytes: read.bytes, hex: true });
      }
      continue;
    }
    if (code === 0x2f) {
      const read = readName(source, index);
      index = read.next;
      if (items.length < MAX_OPERANDS) items.push({ kind: 'name', value: read.value });
      continue;
    }
    if (code === 0x5b && depth < 8) {
      const read = readArray(source, index, depth + 1);
      index = read.next;
      if (items.length < MAX_OPERANDS) items.push({ kind: 'array', value: read.value });
      continue;
    }
    if (isNumberStart(code)) {
      const read = readNumber(source, index);
      index = read.next;
      if (items.length < MAX_OPERANDS) items.push({ kind: 'number', value: read.value });
      continue;
    }
    index += 1;
  }
  return { value: items, next: index };
}

/**
 * Replay a content stream into plain text.
 *
 * Positions are ignored (no font metrics): `Td`/`TD` with a vertical move, `T*`
 * and `ET` break the line; a large negative `TJ` adjustment is a word gap. A
 * horizontal-only `Td` is a word gap only when it moves wider than the font
 * size — CJK exports place every glyph one em apart, and spacing those out
 * turns real sentences into unreadable noise.
 */
function extractContentText(bytes: Uint8Array, fonts: Map<string, FontDecoder>): string {
  const source = latin1String(bytes);
  const lines: string[] = [];
  let current = '';
  let characters = 0;
  let index = 0;
  let operands: ContentToken[] = [];
  let currentFont: FontDecoder | null = null;
  let fontSize: number | null = null;
  let textMatrixY: number | null = null;
  let objectStrings = 0;

  const pushLine = (): void => {
    const line = current.replace(/^[ \t]+/u, '').replace(/[ \t]+$/u, '');
    if (line) lines.push(line);
    current = '';
  };

  const addSpace = (): void => {
    if (current && !/[ \t]$/u.test(current)) current += ' ';
  };

  const appendText = (text: string): void => {
    if (!text) return;
    const parts = text.replace(/\r\n?/gu, '\n').split('\n');
    for (let part = 0; part < parts.length; part += 1) {
      if (part > 0) pushLine();
      const chunk = parts[part] ?? '';
      if (!chunk || characters >= MAX_TEXT_CHARS) continue;
      current += chunk;
      characters += chunk.length;
    }
  };

  const actualText: { text: string | null; emitted: boolean }[] = [];

  const decodeActualText = (hex: string): string | null => {
    const bytes: number[] = [];
    for (let position = 0; position + 1 < hex.length; position += 2) {
      const byte = Number.parseInt(hex.slice(position, position + 2), 16);
      if (!Number.isFinite(byte)) return null;
      bytes.push(byte);
    }
    const text = decodeHexBytes(bytes);
    return text || null;
  };

  /**
   * `/ActualText` is the author's authoritative string for the glyphs it spans.
   * Fonts whose ToUnicode points at Kangxi radical variants (e.g. U+2F60 instead
   * of U+74DC) still extract searchable characters when the span wins.
   */
  const showText = (text: string): void => {
    objectStrings += 1;
    for (let depthIndex = actualText.length - 1; depthIndex >= 0; depthIndex -= 1) {
      const frame = actualText[depthIndex];
      if (!frame?.text) continue;
      if (!frame.emitted) {
        frame.emitted = true;
        appendText(frame.text);
      }
      return;
    }
    appendText(text);
  };

  const lastString = (): StringToken | undefined => {
    for (let position = operands.length - 1; position >= 0; position -= 1) {
      const token = operands[position];
      if (token?.kind === 'string') return token;
    }
    return undefined;
  };

  const lastName = (): string | undefined => {
    for (let position = operands.length - 1; position >= 0; position -= 1) {
      const token = operands[position];
      if (token?.kind === 'name') return token.value;
    }
    return undefined;
  };

  const decodeString = (token: StringToken): string => {
    if (currentFont) return currentFont.decode(Uint8Array.from(token.bytes));
    return token.hex ? decodeHexBytes(token.bytes) : decodeWinAnsi(token.bytes);
  };

  const lastArray = (): ContentToken[] | undefined => {
    for (let position = operands.length - 1; position >= 0; position -= 1) {
      const token = operands[position];
      if (token?.kind === 'array') return token.value;
    }
    return undefined;
  };

  const lastDictionary = (): string | undefined => {
    for (let position = operands.length - 1; position >= 0; position -= 1) {
      const token = operands[position];
      if (token?.kind === 'dict') return token.source;
    }
    return undefined;
  };

  const operandNumbers = (): number[] =>
    operands
      .filter((token): token is { kind: 'number'; value: number } => token.kind === 'number')
      .map((token) => token.value);

  const applyOperator = (operator: string): void => {
    switch (operator) {
      case 'BT':
        objectStrings = 0;
        break;
      case 'ET':
        // A block with one show operation is glyph placement (see `Tm` below);
        // multi-show blocks are real paragraphs, so the block ends the line.
        if (objectStrings >= 2) pushLine();
        break;
      case 'BMC':
        actualText.push({ text: null, emitted: false });
        break;
      case 'BDC': {
        const dictionary = lastDictionary();
        const match = dictionary ? /\/ActualText\s*<([0-9A-Fa-f\s]+)>/.exec(dictionary) : null;
        const text = match ? decodeActualText(match[1] ?? '') : null;
        actualText.push({ text, emitted: false });
        break;
      }
      case 'EMC':
        actualText.pop();
        break;
      case 'Tf': {
        // The font selected here decides how the following strings decode.
        const name = lastName();
        currentFont = name === undefined ? null : (fonts.get(name) ?? null);
        const numbers = operandNumbers();
        const size = numbers[numbers.length - 1];
        if (size !== undefined && size !== 0) fontSize = Math.abs(size);
        break;
      }
      case 'Tj': {
        const token = lastString();
        if (token) showText(decodeString(token));
        break;
      }
      case 'TJ': {
        const array = lastArray();
        if (!array) break;
        for (const item of array) {
          if (item.kind === 'string') showText(decodeString(item));
          else if (item.kind === 'number' && item.value <= TJ_WORD_GAP) addSpace();
        }
        break;
      }
      case "'":
      case '"': {
        // Both move to the next line before showing the string.
        pushLine();
        const token = lastString();
        if (token) showText(decodeString(token));
        break;
      }
      case 'Td':
      case 'TD': {
        const numbers = operandNumbers();
        const vertical = numbers[numbers.length - 1];
        const horizontal = numbers[numbers.length - 2];
        if (vertical !== undefined && vertical !== 0) pushLine();
        else if (horizontal !== undefined && horizontal !== 0) {
          // One em or less is glyph placement (CJK exports do this per glyph);
          // a real word gap is wider. Without a known font size, keep the hint.
          const wordGap = fontSize === null ? 0 : fontSize * 1.5;
          if (Math.abs(horizontal) > wordGap) addSpace();
        }
        break;
      }
      case 'T*':
        pushLine();
        break;
      case 'Tm': {
        // Many exporters put every glyph in its own BT/ET block and move it with
        // `Tm`. A changed Y is a line break; the same Y keeps the current line.
        const numbers = operandNumbers();
        if (numbers.length > 0) {
          const y = numbers[numbers.length - 1] ?? 0;
          if (textMatrixY !== null && Math.abs(y - textMatrixY) > 0.5) pushLine();
          textMatrixY = y;
        }
        break;
      }
      default:
        break;
    }
  };

  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (isWhitespaceCode(code)) {
      index += 1;
      continue;
    }
    if (code === 0x25) {
      const endOfLine = source.indexOf('\n', index);
      index = endOfLine === -1 ? source.length : endOfLine + 1;
      continue;
    }
    if (code === 0x28) {
      const read = readLiteralString(source, index);
      index = read.next;
      operands.push({ kind: 'string', bytes: read.bytes, hex: false });
    } else if (code === 0x3c) {
      const dictionary = readDictionary(source, index);
      if (dictionary) {
        index = dictionary.next;
        operands.push({ kind: 'dict', source: dictionary.body });
      } else {
        const read = readHexString(source, index);
        index = read.next;
        operands.push({ kind: 'string', bytes: read.bytes, hex: true });
      }
    } else if (code === 0x5b) {
      const read = readArray(source, index, 0);
      index = read.next;
      operands.push({ kind: 'array', value: read.value });
    } else if (code === 0x5d) {
      index += 1;
    } else if (code === 0x2f) {
      const read = readName(source, index);
      index = read.next;
      operands.push({ kind: 'name', value: read.value });
    } else if (isNumberStart(code)) {
      const read = readNumber(source, index);
      index = read.next;
      operands.push({ kind: 'number', value: read.value });
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      const read = readOperator(source, index);
      index = read.next;
      if (read.value === 'BI') {
        // Inline image data is arbitrary bytes; skip it instead of tokenizing it.
        index = skipInlineImage(source, index);
      } else {
        applyOperator(read.value);
      }
      operands = [];
    } else if (code === 0x27 || code === 0x22) {
      index += 1;
      applyOperator(source.charAt(index - 1));
      operands = [];
    } else {
      index += 1;
    }
    if (operands.length > MAX_OPERANDS) operands = operands.slice(-MAX_OPERANDS);
  }
  pushLine();
  if (current) pushLine();
  return lines.join('\n');
}

// ── Font / ToUnicode CMaps ─────────────────────────────────────────────────

/** Decodes one string's raw PDF bytes into Unicode text for the selected font. */
interface FontDecoder {
  decode(bytes: Uint8Array): string;
}

interface UnicodeCMap {
  mapping: Map<number, string>;
  codeBytes: number;
}

function decodeCmapDestination(hex: string): string {
  const bytes: number[] = [];
  for (let index = 0; index + 1 < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return decodeUtf16(bytes, true);
}

/**
 * Parse a `/ToUnicode` CMap: `bfchar` pairs and both `bfrange` forms. This is
 * how generated PDFs (Word, browsers, InDesign) expose their real characters
 * even when the content stream carries CID/glyph codes instead of bytes.
 */
function parseUnicodeCMap(source: string): UnicodeCMap | null {
  const mapping = new Map<number, string>();
  let codeBytes = 1;
  let found = false;
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const sourceHex = pair[1] ?? '';
      const destinationHex = pair[2] ?? '';
      if (!sourceHex || !destinationHex) continue;
      mapping.set(Number.parseInt(sourceHex, 16), decodeCmapDestination(destinationHex));
      codeBytes = Math.max(codeBytes, Math.ceil(sourceHex.length / 2));
      found = true;
      if (mapping.size >= 100_000) break;
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    for (const range of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = Number.parseInt(range[1] ?? '', 16);
      const end = Number.parseInt(range[2] ?? '', 16);
      const destination = range[3] ?? '';
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      if (end - start > 65_535) continue;
      const base: number[] = [];
      for (let index = 0; index + 1 < destination.length; index += 2) {
        base.push(Number.parseInt(destination.slice(index, index + 2), 16));
      }
      if (base.length === 0) continue;
      codeBytes = Math.max(codeBytes, Math.ceil((range[1] ?? '').length / 2));
      for (let code = start; code <= end; code += 1) {
        const units = base.slice();
        units[units.length - 1] = (units[units.length - 1] ?? 0) + (code - start);
        mapping.set(code, decodeUtf16(units, true));
        if (mapping.size >= 100_000) break;
      }
      found = true;
    }
    for (const range of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const start = Number.parseInt(range[1] ?? '', 16);
      const end = Number.parseInt(range[2] ?? '', 16);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      codeBytes = Math.max(codeBytes, Math.ceil((range[1] ?? '').length / 2));
      let code = start;
      for (const destination of (range[3] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g)) {
        if (code > end) break;
        mapping.set(code, decodeCmapDestination(destination[1] ?? ''));
        code += 1;
      }
      found = true;
    }
  }
  if (!found || mapping.size === 0) return null;
  return { mapping, codeBytes };
}

function cmapDecoder(cmap: UnicodeCMap): FontDecoder {
  const width = cmap.codeBytes >= 2 ? 2 : 1;
  return {
    decode(bytes: Uint8Array): string {
      let text = '';
      let index = 0;
      while (index + width <= bytes.length) {
        let code = 0;
        for (let offset = 0; offset < width; offset += 1) {
          code = (code << 8) | (bytes[index + offset] ?? 0);
        }
        const mapped = cmap.mapping.get(code);
        if (mapped !== undefined) text += mapped;
        else if (width === 1) text += decodeWinAnsi([code]);
        else if (code >= 0x20 && code < 0x7f) text += String.fromCharCode(code);
        index += width;
      }
      return text;
    },
  };
}

/**
 * Type0 font without a `/ToUnicode` map: the string carries glyph IDs, not
 * characters. Keep only codes that look like plain ASCII/WinAnsi and drop the
 * rest rather than emitting convincing-looking mojibake.
 */
function type0HeuristicDecoder(): FontDecoder {
  return {
    decode(bytes: Uint8Array): string {
      let text = '';
      for (let index = 0; index + 1 < bytes.length; index += 2) {
        const code = ((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0);
        if (code >= 0x20 && code < 0x7f) text += String.fromCharCode(code);
        else if (code >= 0xa0 && code <= 0xff) text += decodeWinAnsi([code]);
      }
      return text;
    },
  };
}

/** Page attributes (`/Resources`, `/Parent`) may be inherited from Pages nodes. */
function resourcesDictionary(
  pageDictionary: string,
  objects: Map<number, PdfObject>
): string | null {
  let dictionary = pageDictionary;
  for (let depth = 0; depth < 32; depth += 1) {
    const keyword = dictionary.indexOf('/Resources');
    if (keyword !== -1) {
      const afterKeyword = keyword + '/Resources'.length;
      const inline = readDictionary(dictionary, afterKeyword);
      if (inline) return inline.body;
      // `/Resources 6 0 R` points at an indirect dictionary.
      const reference = /^\s+(\d+)\s+\d+\s+R/.exec(dictionary.slice(afterKeyword));
      if (reference) {
        const target = objects.get(Number(reference[1] ?? 0));
        if (target) return target.dictionary;
      }
    }
    const parent = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(dictionary);
    if (!parent) return null;
    const parentObject = objects.get(Number(parent[1] ?? 0));
    if (!parentObject) return null;
    dictionary = parentObject.dictionary;
  }
  return null;
}

function fontDecoders(
  pageDictionary: string,
  objects: Map<number, PdfObject>
): Map<string, FontDecoder> {
  const decoders = new Map<string, FontDecoder>();
  const resources = resourcesDictionary(pageDictionary, objects);
  if (!resources) return decoders;
  const keyword = resources.indexOf('/Font');
  if (keyword === -1) return decoders;
  let fontDictionary: string | null = null;
  const inline = readDictionary(resources, keyword + '/Font'.length);
  if (inline) fontDictionary = inline.body;
  else {
    const reference = /\/Font\s+(\d+)\s+\d+\s+R/.exec(resources.slice(keyword));
    if (reference) {
      const target = objects.get(Number(reference[1] ?? 0));
      if (target) fontDictionary = target.dictionary;
    }
  }
  if (!fontDictionary) return decoders;
  for (const match of fontDictionary.matchAll(/\/([^\s/<>[\]()%]+)\s+(\d+)\s+\d+\s+R/g)) {
    const name = match[1] ?? '';
    const font = objects.get(Number(match[2] ?? 0));
    if (!name || !font) continue;
    const toUnicode = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(font.dictionary);
    const cmapObject = toUnicode ? objects.get(Number(toUnicode[1] ?? 0)) : undefined;
    const cmap = cmapObject?.data ? parseUnicodeCMap(latin1String(cmapObject.data)) : null;
    if (cmap) {
      decoders.set(name, cmapDecoder(cmap));
      continue;
    }
    if (/\/Subtype\s*\/Type0\b/.test(font.dictionary)) {
      decoders.set(name, type0HeuristicDecoder());
    }
    // Simple fonts without /ToUnicode keep the WinAnsi default (no decoder).
  }
  return decoders;
}

// ── PDF object / page structure scan ───────────────────────────────────────

interface StreamRange {
  dataStart: number;
  fallbackEnd: number;
  declaredLength: number | null;
  lengthObject: number | null;
}

interface ScannedObject {
  number: number;
  generation: number;
  dictionary: string;
  stream: StreamRange | null;
}

interface PdfObject {
  number: number;
  dictionary: string;
  data: Uint8Array | null;
}

function findStreamKeyword(
  latin: string,
  from: number,
  to: number
): { keywordAt: number; dataStart: number } | null {
  for (let index = from; index + 6 <= to; index += 1) {
    if (latin.charCodeAt(index) !== 0x73) continue; // 's'
    if (!latin.startsWith('stream', index)) continue;
    const previous = index === 0 ? 0x20 : latin.charCodeAt(index - 1);
    if (!isWhitespaceOrDelimiter(previous)) continue;
    let cursor = index + 6;
    const after = latin.charCodeAt(cursor);
    if (after === 0x0d) {
      cursor += 1;
      if (latin.charCodeAt(cursor) === 0x0a) cursor += 1;
    } else if (after === 0x0a) {
      cursor += 1;
    } else {
      continue;
    }
    return { keywordAt: index, dataStart: cursor };
  }
  return null;
}

/**
 * Linear `N G obj … endobj` scan. After each object the regex cursor jumps past
 * its `endobj`, so bytes inside a stream that happen to spell "1 0 obj" are not
 * mistaken for a second definition.
 */
function scanObjects(latin: string): ScannedObject[] {
  const objects: ScannedObject[] = [];
  const objectStart = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  for (let scanned = 0; scanned < MAX_OBJECTS; scanned += 1) {
    const match = objectStart.exec(latin);
    if (!match) break;
    const afterKeyword = match.index + match[0].length;
    const endObject = latin.indexOf('endobj', afterKeyword);
    const limit = endObject === -1 ? latin.length : endObject;
    const number = Number(match[1] ?? 0);
    const generation = Number(match[2] ?? 0);
    const keyword = findStreamKeyword(latin, afterKeyword, limit);
    if (!keyword) {
      objects.push({
        number,
        generation,
        dictionary: latin.slice(afterKeyword, limit),
        stream: null,
      });
    } else {
      const endStream = latin.indexOf('endstream', keyword.dataStart);
      const rawEnd = endStream === -1 || endStream > limit ? limit : endStream;
      let fallbackEnd = rawEnd;
      // The EOL before `endstream` belongs to the keyword, not to the data.
      if (fallbackEnd > keyword.dataStart && latin.charCodeAt(fallbackEnd - 1) === 0x0a) {
        fallbackEnd -= 1;
        if (fallbackEnd > keyword.dataStart && latin.charCodeAt(fallbackEnd - 1) === 0x0d) {
          fallbackEnd -= 1;
        }
      } else if (fallbackEnd > keyword.dataStart && latin.charCodeAt(fallbackEnd - 1) === 0x0d) {
        fallbackEnd -= 1;
      }
      const dictionary = latin.slice(afterKeyword, keyword.keywordAt);
      const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary);
      const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dictionary);
      objects.push({
        number,
        generation,
        dictionary,
        stream: {
          dataStart: keyword.dataStart,
          fallbackEnd,
          declaredLength: direct ? Number(direct[1] ?? 0) : null,
          lengthObject: indirect ? Number(indirect[1] ?? 0) : null,
        },
      });
    }
    objectStart.lastIndex = Math.max(objectStart.lastIndex, limit + 6);
  }
  return objects;
}

function streamFilters(dictionary: string): string[] {
  if (!/\/Filter\b/.test(dictionary)) return [];
  const match = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dictionary);
  if (!match) return [];
  const names: string[] = [];
  for (const name of (match[1] ?? '').matchAll(/\/(\w+)/g)) names.push(name[1] ?? '');
  return names;
}

function inflateStream(bytes: Uint8Array): Uint8Array | null {
  for (const inflate of [inflateSync, inflateRawSync]) {
    try {
      return inflate(bytes, { maxOutputLength: MAX_STREAM_BYTES });
    } catch {
      // Try the next interpretation; a corrupt stream is reported, never thrown.
    }
  }
  return null;
}

function decodeStream(
  bytes: Uint8Array,
  filters: string[]
): { ok: true; data: Uint8Array } | { ok: false } {
  if (filters.length === 0) return { ok: true, data: bytes };
  if (filters.length === 1 && filters[0] === 'FlateDecode') {
    const inflated = inflateStream(bytes);
    return inflated ? { ok: true, data: inflated } : { ok: false };
  }
  return { ok: false };
}

function resolveStreamEnd(object: ScannedObject, byNumber: Map<number, ScannedObject>): number {
  const range = object.stream;
  if (!range) return 0;
  let length = range.declaredLength;
  if (length === null && range.lengthObject !== null) {
    const lengthObject = byNumber.get(range.lengthObject);
    const parsed = lengthObject ? /^\s*(\d+)/.exec(lengthObject.dictionary) : null;
    if (parsed) length = Number(parsed[1] ?? 0);
  }
  if (length !== null && length >= 0) {
    const candidate = range.dataStart + length;
    if (candidate <= range.fallbackEnd + 20) {
      return candidate;
    }
  }
  return range.fallbackEnd;
}

function expandObjectStream(object: PdfObject, objects: Map<number, PdfObject>): void {
  if (!object.data) return;
  const count = Number(/\/N\s+(\d+)/.exec(object.dictionary)?.[1] ?? 0);
  const first = Number(/\/First\s+(\d+)/.exec(object.dictionary)?.[1] ?? 0);
  if (!Number.isFinite(count) || count <= 0 || count > 10_000) return;
  if (!Number.isFinite(first) || first < 0 || first > object.data.length) return;
  const latin = latin1String(object.data);
  const header = latin.slice(0, first);
  const numbers: number[] = [];
  for (const match of header.matchAll(/\d+/g)) {
    numbers.push(Number(match[0]));
    if (numbers.length >= count * 2) break;
  }
  const pairs = Math.min(count, Math.floor(numbers.length / 2));
  for (let pair = 0; pair < pairs; pair += 1) {
    const number = numbers[pair * 2] ?? 0;
    const offset = numbers[pair * 2 + 1] ?? 0;
    const nextOffset =
      pair + 1 < pairs
        ? (numbers[(pair + 1) * 2 + 1] ?? latin.length - first)
        : latin.length - first;
    const start = first + offset;
    const end = first + nextOffset;
    if (start < first || end > latin.length || end <= start) continue;
    if (objects.has(number)) continue;
    const dictionary = latin.slice(start, end).trim();
    if (dictionary) objects.set(number, { number, dictionary, data: null });
  }
}

function buildObjects(
  latin: string,
  bytes: Uint8Array
): { objects: Map<number, PdfObject>; streamFailures: number } {
  const scanned = scanObjects(latin);
  const byNumber = new Map<number, ScannedObject>();
  for (const object of scanned) byNumber.set(object.number, object);
  const objects = new Map<number, PdfObject>();
  let streamFailures = 0;
  let decodedTotal = 0;
  for (const object of scanned) {
    let data: Uint8Array | null = null;
    // Raster images never carry text, so a skipped image is not a decode failure.
    const isImageStream = /\/Subtype\s*\/Image\b/.test(object.dictionary);
    if (object.stream && !isImageStream) {
      const end = resolveStreamEnd(object, byNumber);
      const raw = bytes.subarray(object.stream.dataStart, Math.max(object.stream.dataStart, end));
      const filters = streamFilters(object.dictionary);
      const namesFilter = /\/Filter\b/.test(object.dictionary);
      if (namesFilter && filters.length === 0) {
        // Indirect /Filter (or an unparsable value): cannot decode safely.
        streamFailures += 1;
      } else {
        const decoded = decodeStream(raw, filters);
        if (decoded.ok && decodedTotal + decoded.data.length <= MAX_TOTAL_DECODED_BYTES) {
          data = decoded.data;
          decodedTotal += data.length;
        } else {
          streamFailures += 1;
        }
      }
    }
    objects.set(object.number, { number: object.number, dictionary: object.dictionary, data });
  }
  for (const object of [...objects.values()]) {
    if (object.data && /\/Type\s*\/ObjStm\b/.test(object.dictionary)) {
      expandObjectStream(object, objects);
    }
  }
  return { objects, streamFailures };
}

function isEncryptedPdf(latin: string, objects: Map<number, PdfObject>): boolean {
  let cursor = 0;
  for (;;) {
    const at = latin.indexOf('trailer', cursor);
    if (at === -1) break;
    const dictionaryStart = latin.indexOf('<<', at);
    if (dictionaryStart !== -1) {
      const dictionaryEnd = latin.indexOf('>>', dictionaryStart);
      const dictionary = latin.slice(
        dictionaryStart,
        dictionaryEnd === -1 ? Math.min(dictionaryStart + 4_096, latin.length) : dictionaryEnd
      );
      if (/\/Encrypt\b/.test(dictionary)) return true;
    }
    cursor = at + 7;
  }
  // PDF 1.5+ cross-reference streams carry the trailer entries themselves.
  for (const object of objects.values()) {
    if (/\/Type\s*\/XRef\b/.test(object.dictionary) && /\/Encrypt\b/.test(object.dictionary)) {
      return true;
    }
  }
  return false;
}

function collectPages(objects: Map<number, PdfObject>): string[] {
  const pages: string[] = [];
  const visited = new Set<number>();
  const catalog = [...objects.values()].find((object) =>
    /\/Type\s*\/Catalog\b/.test(object.dictionary)
  );
  if (catalog) {
    const root = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalog.dictionary);
    const walk = (number: number, depth: number): void => {
      if (depth > 64 || visited.has(number) || pages.length >= MAX_PAGES) return;
      visited.add(number);
      const object = objects.get(number);
      if (!object) return;
      if (/\/Type\s*\/Page\b/.test(object.dictionary)) {
        pages.push(object.dictionary);
        return;
      }
      const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(object.dictionary);
      if (!kids) return;
      for (const match of (kids[1] ?? '').matchAll(/(\d+)\s+\d+\s+R/g)) {
        walk(Number(match[1] ?? 0), depth + 1);
      }
    };
    if (root) walk(Number(root[1] ?? 0), 0);
  }
  if (pages.length > 0) return pages;
  // Fallback: page dictionaries are usually still direct objects even when the
  // catalog/page tree lives in an object stream this scan could not follow.
  for (const object of objects.values()) {
    if (/\/Type\s*\/Page\b/.test(object.dictionary)) pages.push(object.dictionary);
  }
  return pages;
}

function pageContentStreams(pageDictionary: string, objects: Map<number, PdfObject>): Uint8Array[] {
  const references: number[] = [];
  const array = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageDictionary);
  if (array) {
    for (const match of (array[1] ?? '').matchAll(/(\d+)\s+\d+\s+R/g)) {
      references.push(Number(match[1] ?? 0));
    }
  } else {
    const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageDictionary);
    if (single) references.push(Number(single[1] ?? 0));
  }
  const streams: Uint8Array[] = [];
  for (const reference of references) {
    const object = objects.get(reference);
    if (object?.data) streams.push(object.data);
  }
  return streams;
}

/** Last-resort page sources when no page tree resolves: streams that look like content. */
function fallbackContentStreams(objects: Map<number, PdfObject>): Uint8Array[] {
  const streams: Uint8Array[] = [];
  const contentOperator = /(?:^|[\s\]\)>])(?:BT|Tj|TJ|Td)(?=[\s[\]\(<%\/]|$)/;
  for (const object of objects.values()) {
    if (!object.data) continue;
    if (/\/Type\s*\/(?:XRef|ObjStm|Metadata)\b/.test(object.dictionary)) continue;
    if (/\/Subtype\s*\/Image\b/.test(object.dictionary)) continue;
    const preview = latin1String(object.data.subarray(0, Math.min(object.data.length, 65_536)));
    if (!contentOperator.test(preview)) continue;
    streams.push(object.data);
  }
  return streams;
}

// ── Extraction result assembly ─────────────────────────────────────────────

interface ExtractedPage {
  number: number;
  text: string;
}

interface PdfExtraction {
  ok: true;
  totalPages: number;
  pages: ExtractedPage[];
  selection: number[];
  charCount: number;
  streamFailures: number;
}

interface PdfFailure {
  ok: false;
  error: string;
}

function parsePageSelection(
  raw: string,
  totalPages: number
): { ok: true; numbers: number[] } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) {
    return { ok: true, numbers: Array.from({ length: totalPages }, (_, index) => index + 1) };
  }
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const token of text.split(',')) {
    const piece = token.trim();
    if (!piece) continue;
    const match = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(piece);
    if (!match) {
      return {
        ok: false,
        error: `has an invalid page range "${text}" — use "3", "1-3" or "1,3-5".`,
      };
    }
    const start = Number(match[1] ?? 0);
    const end =
      match[2] === undefined ? start : match[2] === '' ? totalPages : Number(match[2] ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
      return {
        ok: false,
        error: `has an invalid page range "${text}" — use "3", "1-3" or "1,3-5".`,
      };
    }
    if (start > totalPages || end > totalPages) {
      return {
        ok: false,
        error: `has ${totalPages} page(s); page range "${text}" is out of range.`,
      };
    }
    for (let page = start; page <= end; page += 1) {
      if (!seen.has(page)) {
        seen.add(page);
        numbers.push(page);
      }
    }
  }
  if (numbers.length === 0) {
    return {
      ok: false,
      error: `has an invalid page range "${text}" — use "3", "1-3" or "1,3-5".`,
    };
  }
  return { ok: true, numbers };
}

export function extractPdfText(bytes: Uint8Array, pagesInput: string): PdfExtraction | PdfFailure {
  const header = latin1String(bytes.subarray(0, Math.min(bytes.length, 1_024)));
  if (!header.includes('%PDF-')) {
    return {
      ok: false,
      error:
        'is not a PDF (no %PDF- header in the first 1024 bytes). ' +
        'Use read_file for text files, or check that the path really points at a PDF.',
    };
  }
  const latin = latin1String(bytes);
  const { objects, streamFailures } = buildObjects(latin, bytes);
  if (isEncryptedPdf(latin, objects)) {
    return {
      ok: false,
      error:
        'is encrypted (/Encrypt in the trailer) — read_pdf cannot decrypt it. ' +
        'Save an unencrypted copy (print to PDF) and read that.',
    };
  }

  const pageDictionaries = collectPages(objects);
  let pageContents: Uint8Array[][];
  let pageFonts: Map<string, FontDecoder>[];
  if (pageDictionaries.length > 0) {
    pageFonts = pageDictionaries.map((dictionary) => fontDecoders(dictionary, objects));
    pageContents = pageDictionaries.map((dictionary) => pageContentStreams(dictionary, objects));
  } else {
    const fallback = fallbackContentStreams(objects);
    if (fallback.length === 0) {
      return {
        ok: false,
        error:
          'could not be parsed as a PDF: no page objects or text content streams were found. ' +
          'The file may be damaged or use an unsupported encoding; try another copy or converter.',
      };
    }
    pageFonts = fallback.map(() => new Map<string, FontDecoder>());
    pageContents = fallback.map((stream) => [stream]);
  }

  const pageTexts = pageContents.map((streams, pageIndex) => {
    const fonts = pageFonts[pageIndex] ?? new Map<string, FontDecoder>();
    const parts: string[] = [];
    for (const stream of streams) {
      const text = extractContentText(stream, fonts);
      if (text.trim()) parts.push(text);
    }
    return parts.join('\n');
  });
  if (pageTexts.every((text) => !text.trim())) {
    return {
      ok: false,
      error:
        `has no extractable text — it looks image-only/scanned (${pageTexts.length} page(s) without ` +
        'text operators). Moss does not run OCR: render the pages to images and use read_image, ' +
        'or read a PDF that has a text layer.',
    };
  }

  const selectionResult = parsePageSelection(pagesInput, pageTexts.length);
  if (!selectionResult.ok) return selectionResult;
  const pages: ExtractedPage[] = selectionResult.numbers.map((number) => ({
    number,
    text: pageTexts[number - 1] ?? '',
  }));
  const charCount = pages.reduce((total, page) => total + page.text.length, 0);
  return {
    ok: true,
    totalPages: pageTexts.length,
    pages,
    selection: selectionResult.numbers,
    charCount,
    streamFailures,
  };
}

function compressRanges(values: number[]): string {
  const parts: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const start = values[index] ?? 0;
    let end = start;
    while (index + 1 < values.length && (values[index + 1] ?? 0) === end + 1) {
      index += 1;
      end = values[index] ?? end;
    }
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join(', ');
}

function formatPdfResult(shown: string, extraction: PdfExtraction): string {
  const { totalPages, pages, selection, charCount, streamFailures } = extraction;
  const allSelected =
    selection.length === totalPages && selection.every((value, index) => value === index + 1);
  const selectionNote = allSelected
    ? ''
    : `, showing page${selection.length === 1 ? '' : 's'} ${compressRanges(selection)}`;
  let header =
    `[pdf] ${shown} — ${totalPages} page${totalPages === 1 ? '' : 's'}${selectionNote}, ` +
    `${charCount} char${charCount === 1 ? '' : 's'}`;
  if (streamFailures > 0) {
    header += ` (${streamFailures} content stream${streamFailures === 1 ? '' : 's'} could not be decoded)`;
  }
  const sections = pages.map((page) => {
    const text = page.text.trim();
    return `--- page ${page.number} ---\n${text || '(no extractable text on this page)'}`;
  });
  return [header, ...sections].join('\n\n');
}

type PreparedPdf = { ok: true; text: string } | { ok: false; text: string };

/** Resolve path, enforce the size/type guards, then extract — never throws. */
export async function preparePdfInput(
  input: { path?: unknown; pages?: unknown },
  ctx: Pick<ToolContext, 'workspaceDir'>
): Promise<PreparedPdf> {
  const shown = String(input.path ?? '').trim();
  if (!shown) return { ok: false, text: 'Error: read_pdf needs a path.' };
  const filePath = resolveReadPath(shown, ctx.workspaceDir);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return {
      ok: false,
      text: `Error: ${shown} does not exist. Use list_directory or search_files to find the PDF.`,
    };
  }
  if (stat.isDirectory()) {
    return { ok: false, text: `Error: ${shown} is a directory, not a PDF.` };
  }
  if (stat.size === 0) {
    return { ok: false, text: `Error: ${shown} is empty (0 bytes), so there is no PDF to read.` };
  }
  if (stat.size > READ_PDF_MAX_BYTES) {
    return {
      ok: false,
      text:
        `Error: ${shown} is ${formatBytes(stat.size)} — larger than read_pdf loads ` +
        `(${formatBytes(READ_PDF_MAX_BYTES)}). Split the PDF or extract the pages you need first.`,
    };
  }
  const bytes = await fs.readFile(filePath);
  let outcome: PdfExtraction | PdfFailure;
  try {
    outcome = extractPdfText(new Uint8Array(bytes), String(input.pages ?? ''));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = {
      ok: false,
      error:
        `could not be read as a PDF (${message}). It may be damaged or use an unsupported ` +
        'encoding; try another copy or a converter.',
    };
  }
  if (!outcome.ok) return { ok: false, text: `Error: ${shown} ${outcome.error}` };
  return { ok: true, text: formatPdfResult(shown, outcome) };
}

export const readPdfTool: Tool = {
  name: 'read_pdf',
  description:
    'Extract the text layer of a local PDF (RDK site reports, datasheets, vendor manuals, papers) ' +
    'page by page. Use pages to read a slice such as "1-3" or "2" instead of the whole document. ' +
    'The result starts with a [pdf] header and one `--- page N ---` section per page. ' +
    'Cannot read scanned/image-only PDFs (no OCR, no text layer) or encrypted files — it says so ' +
    'clearly instead of guessing. Not for plain text or source code (read_file), and not for ' +
    'images/screenshots (read_image).',
  metadata: {
    leanDescription:
      'Extract a PDF text page by page ("1-3" slices). Scans/encrypted are reported, not guessed. Not for images.',
    classification: { singleCallExempt: true, discovery: true },
    maxResultTokens: 6_000,
    truncationHint:
      'the PDF text was truncated — re-read a narrower page range with pages (e.g. "4-6")',
    sideEffectClass: 'readonly',
    planMode: 'allow',
    requiresApproval: false,
    // The text is a fresh observation of the file every time (it may have changed).
    noReplay: true,
    freshObservation: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'PDF path relative to the workspace root (absolute paths outside the workspace also work)',
      },
      pages: {
        type: 'string',
        description:
          'Optional 1-based page selection: "3", "1-3", "2-" or "1,3-5" (default: every page)',
      },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    const prepared = await preparePdfInput(input, ctx);
    return prepared.text;
  },
  async executeStructured(input, ctx): Promise<StructuredToolResult> {
    const prepared = await preparePdfInput(input, ctx);
    if (!prepared.ok) {
      return { content: [{ type: 'text', text: prepared.text }], isError: true };
    }
    return { content: [{ type: 'text', text: prepared.text }] };
  },
};
