import { randomUUID } from 'node:crypto';
import { mkdir, open, copyFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
export interface AtomicOptions {
  failAt?: 'before_rename' | 'after_rename';
  checkpoint?: (point: 'before_rename' | 'after_rename') => void | Promise<void>;
}
export class AtomicWriteError extends Error {
  constructor(readonly committed: boolean, options: ErrorOptions) { super('快照提交失败', options); }
}
export async function writeSnapshotAtomic(filePath: string, value: unknown, options: AtomicOptions = {}): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n';
  const directory = path.dirname(filePath);
  const tempDir = path.resolve(directory, '../../.tmp');
  await mkdir(directory, { recursive: true }); await mkdir(tempDir, { recursive: true });
  const temp = path.join(tempDir, randomUUID() + '.json');
  let committed = false;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try { await copyFile(filePath, path.join(directory, 'snapshot.bak.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await options.checkpoint?.('before_rename');
    if (options.failAt === 'before_rename') throw new Error('injected before_rename');
    await rename(temp, filePath); committed = true;
    await options.checkpoint?.('after_rename');
    if (options.failAt === 'after_rename') throw new Error('injected after_rename');
  } catch (cause) { throw new AtomicWriteError(committed, { cause }); }
  finally { await rm(temp, { force: true }); }
}
