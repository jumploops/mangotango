import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [cloudflare()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    target: 'es2022',
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            index: resolve(import.meta.dirname, 'index.html'),
            admin: resolve(import.meta.dirname, 'admin.html'),
            results: resolve(import.meta.dirname, 'results.html'),
          },
        },
      },
    },
  },
});
