import * as fs from 'node:fs';

const FLUSH_THRESHOLD = 1024 * 1024;

export interface BatchedWriter {
  path: string;
  write: (row: string) => Promise<void>;
  end: () => Promise<void>;
}

export function openBatchedWriter(filePath: string): BatchedWriter {
  const stream = fs.createWriteStream(filePath, { encoding: 'utf-8' });
  let buffer = '';

  const flush = (): Promise<void> => {
    if (buffer.length === 0) return Promise.resolve();
    const chunk = buffer;
    buffer = '';
    return new Promise((resolve, reject) => {
      const ok = stream.write(chunk, (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else stream.once('drain', () => resolve());
    });
  };

  return {
    path: filePath,
    async write(row: string): Promise<void> {
      buffer += row;
      if (buffer.length >= FLUSH_THRESHOLD) await flush();
    },
    async end(): Promise<void> {
      await flush();
      await new Promise<void>((resolve) => stream.end(resolve));
    },
  };
}
