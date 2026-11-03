import { createHash } from 'node:crypto';
import { ErrorCode, MossError } from '../../errors.js';

/** A host-selected instruction artifact. It cannot change execution permissions. */
export interface HarnessAdapter {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
  readonly sha256: string;
}

/** Identifies the validated artifact applied to this run's stable prompt. */
export interface HarnessAdapterReceipt {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
}

/** SHA-256 of the UTF-8 JSON array [id, version, instructions], without trimming. */
export function hashHarnessAdapter(
  adapter: Pick<HarnessAdapter, 'id' | 'version' | 'instructions'>
): string {
  return createHash('sha256')
    .update(JSON.stringify([adapter.id, adapter.version, adapter.instructions]), 'utf8')
    .digest('hex');
}

/** Copy before run admission suspends, so callers cannot change an admitted run. */
export function snapshotHarnessAdapter(
  adapter: HarnessAdapter | undefined
): Readonly<HarnessAdapter> | undefined {
  if (adapter === undefined) return undefined;
  const invalid = (): never => {
    throw new MossError({
      code: ErrorCode.USER_INPUT_INVALID,
      message:
        'Invalid harness adapter: require bounded id/version, 1–8192 UTF-8 instruction bytes, and a matching SHA-256.',
    });
  };
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return invalid();
  const { id, version, instructions, sha256 } = adapter;
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    id.length > 128 ||
    typeof version !== 'string' ||
    !version.trim() ||
    version.length > 128 ||
    typeof instructions !== 'string' ||
    !instructions.trim() ||
    Buffer.byteLength(instructions, 'utf8') > 8192 ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    return invalid();
  }
  const snapshot = { id, version, instructions, sha256 };
  if (hashHarnessAdapter(snapshot) !== sha256) return invalid();
  return Object.freeze(snapshot);
}
