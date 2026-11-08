import { defineConfig } from 'vitest/config';
import { ownPackages } from './resolve.mjs';

export default defineConfig({
  plugins: [ownPackages()],
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
