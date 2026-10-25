import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import * as electron from 'electron'
import type { AppSettings } from '../shared/ipc'
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../shared/approval'

export interface GuardFields {
  permissionMode: PermissionMode
  guardOutsideWrites: boolean
  guardAllowRoots: string[]
}

export interface GuardSealStore {
  read(): Promise<GuardFields | null>
  write(fields: GuardFields): Promise<void>
}

export function guardFieldsOf(settings: AppSettings): GuardFields {
  return {
    permissionMode: settings.permissionMode === 'all' ? 'all' : DEFAULT_PERMISSION_MODE,
    guardOutsideWrites: settings.guardOutsideWrites === true,
    guardAllowRoots: [...(settings.guardAllowRoots ?? [])]
  }
}

export function sameGuardFields(a: GuardFields, b: GuardFields): boolean {
  return a.permissionMode === b.permissionMode &&
    a.guardOutsideWrites === b.guardOutsideWrites &&
    a.guardAllowRoots.length === b.guardAllowRoots.length &&
    a.guardAllowRoots.every((root, index) => root === b.guardAllowRoots[index])
}

export function trustedGuardFields(file: GuardFields, seal: GuardFields | null): GuardFields {
  if (!seal) return { ...file, guardAllowRoots: [...file.guardAllowRoots], permissionMode: DEFAULT_PERMISSION_MODE }
  return {
    permissionMode: file.permissionMode === 'all' && seal.permissionMode === 'all' ? 'all' : DEFAULT_PERMISSION_MODE,
    guardOutsideWrites: file.guardOutsideWrites || seal.guardOutsideWrites,
    guardAllowRoots: file.guardAllowRoots.filter((root) => seal.guardAllowRoots.includes(root))
  }
}

function parseGuardFields(value: unknown): GuardFields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const box = value as Record<string, unknown>
  if (box.permissionMode !== 'all' && box.permissionMode !== 'danger') return null
  if (typeof box.guardOutsideWrites !== 'boolean') return null
  if (!Array.isArray(box.guardAllowRoots) || !box.guardAllowRoots.every((root) => typeof root === 'string')) return null
  return { permissionMode: box.permissionMode, guardOutsideWrites: box.guardOutsideWrites, guardAllowRoots: box.guardAllowRoots as string[] }
}

export async function electronGuardSealStore(): Promise<GuardSealStore | null> {
  const { app, safeStorage } = electron as Partial<typeof electron>
  if (!app || !safeStorage || typeof app.whenReady !== 'function' || typeof safeStorage.encryptString !== 'function') return null
  await app.whenReady()
  if (!safeStorage.isEncryptionAvailable()) return null
  const file = join(app.getPath('userData'), 'guard-seal.bin')
  return {
    async read() {
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return null
      }
      try {
        return parseGuardFields(JSON.parse(safeStorage.decryptString(Buffer.from(text.trim(), 'base64'))))
      } catch {
        return null
      }
    },
    async write(fields) {
      await mkdir(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, safeStorage.encryptString(JSON.stringify(fields)).toString('base64'), 'utf8')
      try {
        await rename(temp, file)
      } catch (error) {
        await unlink(temp).catch(() => undefined)
        throw error
      }
    }
  }
}
