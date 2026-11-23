import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

// Build en UN SEUL fichier HTML (JS + CSS inline) : servi tel quel dans l'iframe sandboxée.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  logLevel: 'warn',
  // Noms de composants conservés : la pile de composants des erreurs reste lisible (Panel ← App…) malgré la minification.
  esbuild: { keepNames: true },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 5000, reportCompressedSize: false },
});
