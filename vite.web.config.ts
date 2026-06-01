import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.HIVE_WEB_HOST ?? '127.0.0.1'
const port = Number(process.env.HIVE_WEB_PORT ?? process.env.PORT ?? 5173)
const hmrHost = host === '0.0.0.0' ? 'localhost' : host

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  assetsInclude: ['**/*.lottie'],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  server: {
    host,
    port,
    strictPort: false,
    hmr: {
      host: hmrHost
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer-web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        pet: resolve(__dirname, 'src/renderer/pet.html')
      }
    }
  }
})
