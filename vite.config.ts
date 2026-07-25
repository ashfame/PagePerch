import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { GUTENBERG_SINGLETON_PACKAGES } from './src/build/gutenbergCompatibility';
import { mv3CompatibilityPlugin } from './src/build/mv3Compatibility';

const projectRoot = import.meta.dirname;

export default defineConfig({
  root: resolve(projectRoot, 'src'),
  publicDir: resolve(projectRoot, 'public'),
  plugins: [mv3CompatibilityPlugin(), react()],
  resolve: {
    dedupe: [...GUTENBERG_SINGLETON_PACKAGES],
  },
  build: {
    assetsInlineLimit: 0,
    cssCodeSplit: true,
    emptyOutDir: true,
    modulePreload: false,
    outDir: resolve(projectRoot, 'dist'),
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        options: resolve(projectRoot, 'src/options.html'),
        'service-worker': resolve(projectRoot, 'src/service-worker.ts'),
        'side-panel': resolve(projectRoot, 'src/side-panel.html'),
      },
      output: {
        assetFileNames: 'assets/[name][extname]',
        chunkFileNames: 'assets/[name].js',
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker'
            ? 'service-worker.js'
            : 'assets/[name].js',
      },
    },
    sourcemap: false,
    target: 'chrome114',
  },
});
