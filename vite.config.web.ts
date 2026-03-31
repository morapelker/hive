import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/renderer',
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true
  },
  server: {
    allowedHosts: true,
    proxy: {
      '/graphql': {
        target: 'http://127.0.0.1:59999',
        ws: true
      },
      '/api': {
        target: 'http://127.0.0.1:59999'
      }
    }
  }
})
