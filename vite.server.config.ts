import { resolve } from 'path'
import { defineConfig } from 'vite'

// Standalone build for the HTTP backend (`src/server/bin.ts` -> out/main/server.js).
//
// The server is spawned as its own process (the Electron binary in
// ELECTRON_RUN_AS_NODE mode, or plain `node`), so its bundle must NOT contain
// `require('electron')`. We build it separately from the Electron `main` bundle
// (electron.vite.config.ts) — no shared chunks — using plain Vite in SSR/node
// mode rather than electron-vite. electron-vite's `main` preset force-marks
// `electron` as external (emitting `require('electron')`), which we cannot
// override; plain Vite does not, so the `electron` alias below resolves to our
// stub (src/server/electron-stub.ts) and is bundled inline instead.
//
// SSR mode externalizes real node dependencies (better-sqlite3, node-pty, effect,
// ...) so they're required from node_modules at runtime, exactly like the main
// build. Output lands in out/main alongside the main bundle (emptyOutDir: false,
// since the main build runs first); server chunks go under out/main/server-chunks
// to avoid colliding with the main build's out/main/chunks.
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'src/server/electron-stub.ts'),
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/main'),
    emptyOutDir: false,
    target: 'node20',
    ssr: true,
    rollupOptions: {
      input: {
        server: resolve(__dirname, 'src/server/bin.ts')
      },
      output: {
        format: 'cjs',
        entryFileNames: '[name].js',
        chunkFileNames: 'server-chunks/[name]-[hash].js'
      }
    }
  }
})
