/**
 * D7 PDF-reading probe: read_pdf extracts page-delimited text from real PDF
 * bytes (plain and FlateDecode), honors page ranges, and refuses encrypted,
 * image-only and damaged files with an explanation instead of crashing.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'read-pdf',
  requires: ['build'],
  description: 'read_pdf extracts page text, page ranges work, and bad PDFs fail clearly',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/read-pdf.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[read-pdf] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
