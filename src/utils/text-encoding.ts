/**
 * Text encodings a BOM can identify. UTF-16 text is half NUL bytes, so a
 * byte-level "binary" check calls a PowerShell script or a Windows log
 * binary; reading and writing through the BOM keeps those files intact.
 */
export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/** Decode bytes to text, matching the encoding named by any leading BOM. */
export function decodeTextBytes(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    // swap16 throws on an odd length, and a truncated code unit is not text.
    const swapped = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf-8'), encoding: 'utf8bom' };
  }
  return { text: buf.toString('utf-8'), encoding: 'utf8' };
}

/** True when a BOM marks the bytes as UTF-16, whose NULs are not a binary signal. */
export function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  );
}

/** Encode text in `encoding`, restoring the BOM that `decodeTextBytes` consumed. */
export function encodeTextBytes(text: string, encoding: TextEncoding): Buffer {
  if (encoding === 'utf16le') return Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf16be') {
    const body = Buffer.from(text, 'utf16le');
    body.swap16();
    return Buffer.concat([UTF16BE_BOM, body]);
  }
  if (encoding === 'utf8bom') return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf-8')]);
  return Buffer.from(text, 'utf-8');
}
