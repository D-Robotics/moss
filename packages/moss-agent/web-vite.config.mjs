import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: path.join(packageRoot, 'dist', 'web-ui', 'client'),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(packageRoot, 'src', 'web-ui', 'client', 'workbench.tsx'),
      formats: ['es'],
      fileName: () => 'workbench.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith('.css'))
            ? 'workbench.css'
            : '[name][extname]',
      },
    },
  },
});
