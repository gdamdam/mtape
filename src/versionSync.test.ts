// package.json is the version source of truth (__APP_VERSION__ is injected
// from it by vite.config.ts); the README badge is the one manual sync point.
import { describe, expect, it } from 'vitest'
import pkgRaw from '../package.json?raw'
import readme from '../README.md?raw'

describe('version sync', () => {
  it('README badge matches package.json', () => {
    const pkgVersion = (JSON.parse(pkgRaw) as { version: string }).version
    expect(readme.match(/badge\/version-([\d.]+)-/)?.[1]).toBe(pkgVersion)
  })
})
