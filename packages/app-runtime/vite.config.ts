import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  logLevel: 'warn',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, reportCompressedSize: false, chunkSizeWarningLimit: 4000 },
});
