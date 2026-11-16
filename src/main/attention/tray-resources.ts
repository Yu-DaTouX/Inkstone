import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTrayAssetStore, type TrayAnimationState, type TrayAssetStore, type TrayFrameSet, type TrayTheme } from './tray-assets'

export interface TrayResourceDeps<Image> {
  appPath(): string
  moduleDir: string
  darkSystem(): boolean
  createImage(path: string): Image
  emptyImage(): Image
  onWarn(message: string): void
}

export interface TrayResources<Image> {
  iconPath(): string | undefined
  theme(): TrayTheme
  image(): Image
  ensureAssets(): void
  assets(state: TrayAnimationState, theme: TrayTheme): TrayFrameSet | undefined
}

export function createTrayResources<Image>(deps: TrayResourceDeps<Image>): TrayResources<Image> {
  let trayAssets: TrayAssetStore | null = null

  const iconPath = (): string | undefined => {
    const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    const iconCandidates = [
      join(deps.appPath(), 'build', file),
      join(deps.moduleDir, '..', '..', 'build', file),
      join(deps.appPath(), 'build', 'icon.png')
    ]
    return iconCandidates.find((candidate) => existsSync(candidate))
  }

  const theme = (): TrayTheme => (deps.darkSystem() ? 'on-dark' : 'on-light')

  const trayDirs = (): string[] => [join(deps.appPath(), 'build', 'tray'), join(deps.moduleDir, '..', '..', 'build', 'tray')]

  const image = (): Image => {
    const name = theme() === 'on-dark' ? 'tray-on-dark.png' : 'tray-on-light.png'
    const candidates = trayDirs().map((dir) => join(dir, name))
    const found = candidates.find((candidate) => existsSync(candidate))
    if (found) return deps.createImage(found)
    const path = iconPath()
    return path ? deps.createImage(path) : deps.emptyImage()
  }

  const ensureAssets = (): void => {
    if (!trayAssets) {
      trayAssets = createTrayAssetStore({
        dirs: trayDirs(),
        createImage: (path) => deps.createImage(path),
        readFile: (path) => readFileSync(path, 'utf8'),
        exists: (path) => existsSync(path),
        onWarn: (message) => deps.onWarn(message)
      })
    }
    trayAssets.load()
  }

  return {
    iconPath,
    theme,
    image,
    ensureAssets,
    assets: (state, current) => trayAssets?.set(state, current)
  }
}
