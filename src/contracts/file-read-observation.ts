/** Claude Code FileRead "unchanged since last read" stub — saves context. */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.';

/** The earlier result was truncated, so its dropped region is not in context. */
export const FILE_UNCHANGED_TRUNCATED_STUB =
  'File unchanged since last read, but the earlier result was TRUNCATED by the output budget — the dropped region is not in context. Re-read just the region you need with offset/limit instead of the whole file.';
