import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Renames the output HTML from android-index.html → index.html
function renameHtmlPlugin(): Plugin {
  return {
    name: 'rename-android-html',
    generateBundle(_opts, bundle) {
      const entry = bundle['android-index.html'];
      if (entry && entry.type === 'asset') {
        entry.fileName = 'index.html';
      }
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), renameHtmlPlugin()],
  build: {
    outDir: resolve(__dirname, 'dist-android'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/android-index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
});
