import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultWriteChain } from './write-chain.js';

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await atomicWriteBytes(filePath, Buffer.from(content, 'utf-8'));
}

/** Like `atomicWriteFile`, for callers that must keep the file's own encoding. */
export async function atomicWriteBytes(filePath: string, bytes: Uint8Array): Promise<void> {
  const resolved = path.resolve(filePath);
  await defaultWriteChain.enqueue(resolved, () => writeAtomically(resolved, bytes));
}

async function writeAtomically(resolved: string, bytes: Uint8Array): Promise<void> {
  const dir = path.dirname(resolved);

  const tmpPath = `${resolved}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, bytes);
    await fs.rename(tmpPath, resolved);
  } catch (err) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}
