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
  build: {
    chunkSizeWarningLimit: 6000,
    // Clang fetches its .wasm/.tar by URL: never inline them as data: URLs (the CSP has no data: in connect-src).
    assetsInlineLimit: (file) => (/\.(wasm|tar|pch)$/.test(file) ? false : undefined),
  },
  // Pre-bundling would move @yowasp/clang away from the files it loads by relative URL.
  optimizeDeps: { exclude: ['@astral-sh/ruff-wasm-web', '@yowasp/clang'] },
  worker: { format: 'es' },
  server: {
    headers: isolation,
    proxy: {
      '/api': { target: process.env.BACKEND_URL ?? 'http://127.0.0.1:8090', ws: true },
      '^/s/[^/]+/mcp$': { target: process.env.BACKEND_URL ?? 'http://127.0.0.1:8090' },
    },
  },
  preview: { headers: isolation },
})
