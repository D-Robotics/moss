import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: path.join(packageRoot, 'dist', 'web-ui', 'client'),
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: path.join(packageRoot, 'src', 'web-ui', 'client', 'moss-web-components.tsx'),
      formats: ['es'],
      fileName: () => 'moss-web-components.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith('.css'))
            ? 'moss-web-components.css'
            : '[name][extname]',
      },
    },
  },
});
