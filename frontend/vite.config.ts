import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const gw = process.env.FORMULE_GATEWAY_URL ?? 'http://127.0.0.1:4000';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: process.env.HOST ?? '127.0.0.1',
    proxy: { '/api': { target: gw, changeOrigin: false }, '/apps': gw, '/health': gw },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
