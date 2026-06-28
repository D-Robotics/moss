














import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultWriteChain } from './write-chain.js';












export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const resolved = path.resolve(filePath);
  await defaultWriteChain.enqueue(resolved, () => writeAtomically(resolved, content));
}

async function writeAtomically(resolved: string, content: string): Promise<void> {
  const dir = path.dirname(resolved);
  
  
  
  
  
  const tmpPath = `${resolved}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, resolved);
  } catch (err) {
    
    
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      
    }
    throw err;
  }
}
