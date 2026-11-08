import { open } from 'node:fs/promises';
import type { ByteSource } from '../../src/img/source';

export async function nodeSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();
  return {
    size,
    async read(offset: number, length: number) {
      const buf = new Uint8Array(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    },
    close: () => fh.close(),
  };
}
