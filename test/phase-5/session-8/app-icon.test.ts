import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const resourcesDir = resolve(__dirname, '../../../resources')

describe('Session 8: App Icon', () => {
  test('icon.icns exists in resources', () => {
    const icnsPath = resolve(resourcesDir, 'icon.icns')
    expect(existsSync(icnsPath)).toBe(true)

    const stats = readFileSync(icnsPath)
    expect(stats.length).toBeGreaterThan(0)
  })

  test('icon.ico exists in resources', () => {
    const icoPath = resolve(resourcesDir, 'icon.ico')
    expect(existsSync(icoPath)).toBe(true)

    const stats = readFileSync(icoPath)
    expect(stats.length).toBeGreaterThan(0)
  })

  test('icon.png exists in resources', () => {
    const pngPath = resolve(resourcesDir, 'icon.png')
    expect(existsSync(pngPath)).toBe(true)

    const data = readFileSync(pngPath)
    expect(data.length).toBeGreaterThan(0)
  })

  test('icon.png is a valid PNG file', () => {
    const pngPath = resolve(resourcesDir, 'icon.png')
    const data = readFileSync(pngPath)

    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(data.subarray(0, 8).equals(pngMagic)).toBe(true)
  })

  test('icon.icns has valid ICNS header', () => {
    const icnsPath = resolve(resourcesDir, 'icon.icns')
    const data = readFileSync(icnsPath)

    // ICNS magic bytes: 'icns' (69 63 6E 73)
    const magic = data.subarray(0, 4).toString('ascii')
    expect(magic).toBe('icns')
  })

  test('icon.ico has valid ICO header', () => {
    const icoPath = resolve(resourcesDir, 'icon.ico')
    const data = readFileSync(icoPath)

    // ICO header: reserved=0, type=1 (ICO)
    expect(data.readUInt16LE(0)).toBe(0) // Reserved
    expect(data.readUInt16LE(2)).toBe(1) // Type: ICO
    expect(data.readUInt16LE(4)).toBeGreaterThanOrEqual(1) // At least 1 image
  })

  test('icon.ico contains multiple resolutions', () => {
    const icoPath = resolve(resourcesDir, 'icon.ico')
    const data = readFileSync(icoPath)

    const imageCount = data.readUInt16LE(4)
    // Should have at least 4 resolutions (16, 32, 48, 64, 128, 256)
    expect(imageCount).toBeGreaterThanOrEqual(4)
  })

  test('electron-builder config exists and references icons', () => {
    const configPath = resolve(__dirname, '../../../electron-builder.yml')
    expect(existsSync(configPath)).toBe(true)

    const content = readFileSync(configPath, 'utf-8')

    // Verify mac icon config
    expect(content).toContain('icon.icns')

    // Verify win icon config
    expect(content).toContain('icon.ico')

    // Verify linux icon config
    expect(content).toContain('icon.png')
  })

  test('source icon is a valid PNG', () => {
    const sourcePath = '/tmp/appicon-test.png'
    if (!existsSync(sourcePath)) {
      // Source icon may not be present in CI
      return
    }

    const data = readFileSync(sourcePath)
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(data.subarray(0, 8).equals(pngMagic)).toBe(true)
  })
})
