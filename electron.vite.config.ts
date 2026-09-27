import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Voice dictation speech engine — forked as an Electron utility process
          // by src/main/voice/voice-engine.ts (out/main/voice-engine-worker.js).
          'voice-engine-worker': resolve(__dirname, 'src/main/voice/voice-engine-worker.ts')
          // The server (`src/server/bin.ts`) is built separately via
          // electron.vite.server.config.ts so it can be electron-free — it runs
          // as its own Node process and must not contain `require('electron')`.
        }
      }
    },
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@preload': resolve('src/preload')
      }
    }
  },
  renderer: {
    assetsInclude: ['**/*.lottie'],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          pet: resolve(__dirname, 'src/renderer/pet.html'),
          voiceHud: resolve(__dirname, 'src/renderer/voice-hud.html')
        }
      }
    }
  }
})
