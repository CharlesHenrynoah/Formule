import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: path.resolve(__dirname, '../../frontend/src') + '/' },
      { find: /^es-css\/tw-animate\.css/, replacement: path.resolve(__dirname, '../../node_modules/tw-animate-css/dist/tw-animate.css') },
      { find: /^es-css\/shadcn\.css/, replacement: path.resolve(__dirname, '../../node_modules/shadcn/dist/tailwind.css') },
    ],
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: { entry: path.resolve(__dirname, 'src/runtime.ts'), name: 'ESRuntimeBundle', formats: ['iife'], fileName: () => 'es-runtime.js' },
    minify: 'esbuild',
    chunkSizeWarningLimit: 4000,
  },
});
