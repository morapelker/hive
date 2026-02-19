/**
 * Monaco Editor setup for Electron environment.
 *
 * By default, @monaco-editor/react loads Monaco from a CDN (cdn.jsdelivr.net).
 * Our CSP blocks external scripts (`script-src 'self'`), so we configure
 * the loader to use the locally bundled monaco-editor package instead.
 *
 * This file MUST be imported before any Monaco component renders.
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

// Configure web worker for diff computation and other editor services
self.MonacoEnvironment = {
  getWorker: () => new editorWorker()
}

// Tell @monaco-editor/react to use the local monaco-editor package (no CDN)
loader.config({ monaco })
