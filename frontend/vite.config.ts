import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// SharedArrayBuffer (blocking input() in the Python worker) needs a
// cross-origin isolated page.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // y-monaco imports Monaco's ESM sources by path: point it at our copy.
      {
        find: /^monaco-editor\/esm\/vs\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, './node_modules/monaco-editor/esm/vs/$1'),
      },
      { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
      { find: 'monaco-esm', replacement: path.resolve(import.meta.dirname, './node_modules/monaco-editor/esm/vs') },
    ],
  },
  build: { chunkSizeWarningLimit: 6000 },
  optimizeDeps: { exclude: ['@astral-sh/ruff-wasm-web'] },
  worker: { format: 'es' },
  server: {
    headers: isolation,
    proxy: { '/api': { target: process.env.BACKEND_URL ?? 'http://127.0.0.1:8090', ws: true } },
  },
  preview: { headers: isolation },
})
