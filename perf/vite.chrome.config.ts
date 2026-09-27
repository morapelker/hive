import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Serves perf/chrome/index.html: the real ProjectList mounted with the 200-project
// fixture and a counting RPC mock, driven by perf/chrome/run-chrome-bench.mjs.
export default defineConfig({
  root: resolve(__dirname, 'chrome'),
  assetsInclude: ['**/*.lottie'],
  resolve: {
    alias: {
      '@': resolve(__dirname, '../src/renderer/src'),
      '@shared': resolve(__dirname, '../src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    fs: { allow: [resolve(__dirname, '..')] }
  }
})
