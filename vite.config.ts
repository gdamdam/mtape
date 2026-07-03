import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import packageJson from './package.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Emit a JSON list of the content-hashed build assets (JS/CSS/worklet) so the
// service worker can precache them at install. The SW activates only after the
// first visit's assets have already loaded, so without an explicit manifest those
// hashed files would not be cached until re-requested — breaking the first
// offline load. Paths are relative to the app base; the SW prepends its scope.
function precacheManifest(): Plugin {
  return {
    name: 'mtape-precache-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((fileName) => !fileName.endsWith('.html') && fileName !== 'precache-manifest.json')
        .sort()
      this.emitFile({
        type: 'asset',
        fileName: 'precache-manifest.json',
        source: JSON.stringify(assets),
      })
    },
    async writeBundle(options, bundle) {
      const dir = typeof options.dir === 'string' ? options.dir : 'dist'
      const swPath = resolve(dir, 'sw.js')
      const fingerprint = createHash('sha256')
        .update(Object.keys(bundle).sort().join('\n'))
        .digest('hex')
        .slice(0, 16)
      const source = await readFile(swPath, 'utf8')
      await writeFile(swPath, source.replaceAll('__BUILD_FINGERPRINT__', fingerprint))
    },
  }
}

export default defineConfig({
  // Root-domain deployment (mtape.mpump.live), not a repo subpath. Override with
  // VITE_BASE_PATH for preview builds under a subdirectory.
  base: process.env.VITE_BASE_PATH ?? '/',
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [react(), precacheManifest()],
  build: {
    target: 'es2022',
  },
  test: {
    // DSP/unit tests run in node; UI tests opt into jsdom per-file via the
    // `// @vitest-environment jsdom` pragma at the top of the test file.
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
