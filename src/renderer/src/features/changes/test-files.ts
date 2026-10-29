export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const HIDE_TEST_FILES_KEY = 'inkstone.changes.hideTestFiles'

const TEST_DIRS = new Set(['__test__', '__tests__', 'cypress', 'e2e', 'playwright', 'spec', 'specs', 'test', 'tests'])
const TEST_NAME = /(\.(test|spec|e2e)\.[^./]+$|_(test|spec)\.[^./]+$|^test_.+\.py$|^conftest\.py$)/i
const CLASS_TEST_NAME = /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/

export function isTestFilePath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/')
  const name = segments.pop() ?? ''
  if (!name) return false
  if (segments.some((segment) => TEST_DIRS.has(segment.toLowerCase()))) return true
  return TEST_NAME.test(name) || CLASS_TEST_NAME.test(name)
}

export function testFilePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => isTestFilePath(path))
}

export function countTestFiles(paths: readonly string[]): number {
  let count = 0
  for (const path of paths) if (isTestFilePath(path)) count += 1
  return count
}

export function withoutTestFiles<T extends { path: string }>(items: readonly T[]): T[] {
  return items.filter((item) => !isTestFilePath(item.path))
}

function localStorageOrNull(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readHideTestFiles(target: StorageLike | null = localStorageOrNull()): boolean {
  try {
    return target?.getItem(HIDE_TEST_FILES_KEY) === '1'
  } catch {
    return false
  }
}

export function writeHideTestFiles(next: boolean, target: StorageLike | null = localStorageOrNull()): void {
  try {
    target?.setItem(HIDE_TEST_FILES_KEY, next ? '1' : '0')
  } catch {
    return
  }
}
