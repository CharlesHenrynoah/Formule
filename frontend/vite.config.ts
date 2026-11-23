import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const voice = process.env.VOICE_GATEWAY_URL ?? 'http://localhost:4006';
// Voix (Google) : proxifiée vers le voice-gateway local, la clé API reste côté serveur.
const voiceProxy = { target: voice, ws: true, changeOrigin: false, rewrite: (p: string) => p.replace(/^\/voice/, '') };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { proxy: { '/api': { target: gateway, changeOrigin: true }, '/health': gateway, '/runtime': gateway, '/voice': voiceProxy } },
  preview: { proxy: { '/api': { target: gateway, changeOrigin: true }, '/health': gateway, '/runtime': gateway, '/voice': voiceProxy } },
});
