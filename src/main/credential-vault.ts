import { appendFile, chmod, mkdir, open as openFile, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { pick } from '../shared/ui-lang'
import { CREDENTIAL_VAULT_ERROR } from '../shared/credential-vault'
import { atomicWriteFile } from './atomic-write'
import { PORTABLE_DATA_DIR, YAN_DIR } from './paths'

const SEALED_PREFIX = 'inkstone-sealed:'
const SEALED_V1 = `${SEALED_PREFIX}v1:`
const NO_KEY_ID = '-'
const LOG_FILE = 'credential-vault.log'
const BACKUP_MARK = '.plaintext-'
const PLAINTEXT_ARG = '--yan-plaintext-credentials'
const STATE_FILE = 'credential-vault-state.json'
const STABLE_STARTS = 5
const BACKUP_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000
const CREDENTIAL_FILES = ['api-keys.json', 'codex-accounts.json', 'image-config.json', 'oauth-accounts.json', 'relay-bridge.json', 'search-config.json']

export interface CredentialCipher {
  available(): Promise<boolean>
  encrypt(text: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<{ text: string; stale: boolean }>
  keyId?(): Promise<string | undefined>
}

type AsyncSafeStorage = Pick<Electron.SafeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync'>

export interface CredentialVault {
  read(file: string): Promise<string | null>
  write(file: string, text: string, options?: { background?: boolean }): Promise<void>
  sweep(files: string[]): Promise<void>
  backups(files: string[]): Promise<string[]>
  removeBackups(files: string[], remove: (file: string) => Promise<void>): Promise<{ removed: string[]; failed: string[]; skipped: string[] }>
}

export interface CredentialVaultIo {
  atomicWrite(file: string, content: string): Promise<void>
  createEmpty(file: string, mode: number): Promise<void>
}

export interface CredentialVaultDeps {
  cipher: CredentialCipher
  plaintext: () => boolean
  log: (file: string, line: string) => void | Promise<void>
  restrict?: (file: string) => Promise<void>
  io?: Partial<CredentialVaultIo>
  now?: () => number
}

interface VaultState {
  version: 1
  files: Record<string, { okStarts: number; updatedAt: string }>
}

export class CredentialVaultError extends Error {
  constructor(message: string, readonly file: string, readonly backups: string[]) {
    super(message)
    this.name = CREDENTIAL_VAULT_ERROR
  }
}

export function plaintextCredentialsRequested(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv, portable: boolean = !!PORTABLE_DATA_DIR): boolean {
  if (portable || env.YAN_PLAINTEXT_CREDENTIALS?.trim() === '1') return true
  return argv.some((arg) => arg === PLAINTEXT_ARG || arg === `${PLAINTEXT_ARG}=1`)
}

export function credentialFilesIn(dir: string): string[] {
  return CREDENTIAL_FILES.map((name) => join(dir, name))
}

export async function localStateKeyFingerprint(read: () => Promise<string>): Promise<string | undefined> {
  try {
    const state = JSON.parse(await read()) as { os_crypt?: { encrypted_key?: unknown } } | null
    const key = state?.os_crypt?.encrypted_key
    return typeof key === 'string' && key.length > 0 ? createHash('sha256').update(key).digest('hex').slice(0, 16) : undefined
  } catch {
    return undefined
  }
}

export function safeStorageCipher(load: () => Promise<AsyncSafeStorage | null>, keyId?: () => Promise<string | undefined>): CredentialCipher {
  let loaded: Promise<AsyncSafeStorage | null> | null = null
  const storage = async (): Promise<AsyncSafeStorage | null> => {
    loaded ??= load().then(
      (api) => api && typeof api.isAsyncEncryptionAvailable === 'function' && typeof api.encryptStringAsync === 'function' && typeof api.decryptStringAsync === 'function' ? api : null,
      () => null
    )
    const api = await loaded
    try {
      return api && (await api.isAsyncEncryptionAvailable()) ? api : null
    } catch {
      return null
    }
  }
  return {
    available: async () => !!(await storage()),
    async encrypt(text) {
      const api = await storage()
      if (!api) throw new Error('safeStorage unavailable')
      return api.encryptStringAsync(text)
    },
    async decrypt(data) {
      const api = await storage()
      if (!api) throw new Error('safeStorage unavailable')
      const result = await api.decryptStringAsync(data)
      return { text: result.result, stale: result.shouldReEncrypt === true }
    },
    keyId: keyId && (() => keyId().catch(() => undefined))
  }
}

async function electronSafeStorage(): Promise<AsyncSafeStorage | null> {
  const { app, safeStorage } = (await import('electron')) as Partial<typeof import('electron')>
  if (!app || !safeStorage || typeof app.whenReady !== 'function') return null
  await app.whenReady()
  return safeStorage
}

async function electronKeyId(): Promise<string | undefined> {
  const { app } = (await import('electron')) as Partial<typeof import('electron')>
  if (!app || typeof app.getPath !== 'function') return undefined
  const file = join(app.getPath('userData'), 'Local State')
  return localStateKeyFingerprint(() => readFile(file, 'utf8'))
}

function systemTool(name: string): string {
  return join(process.env.SystemRoot?.trim() || process.env.windir?.trim() || 'C:\\Windows', 'System32', name)
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message} ${String(stderr || stdout).trim()}`.trim()))
      else resolve(String(stdout))
    })
  })
}

let currentSid: Promise<string> | null = null

export function parseWhoamiSid(output: string): string | undefined {
  return output.match(/S-1-\d+(?:-\d+)+/)?.[0]
}

async function userSid(): Promise<string> {
  currentSid ??= run(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).then((output) => {
    const sid = parseWhoamiSid(output)
    if (!sid) throw new Error(`whoami returned no SID: ${output.trim()}`)
    return sid
  })
  currentSid.catch(() => {
    currentSid = null
  })
  return currentSid
}

async function restrictToCurrentUser(file: string): Promise<void> {
  if (process.platform !== 'win32') return
  await run(systemTool('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${await userSid()}:(F)`])
}

function digestOf(data: string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

function formatSealed(keyId: string | undefined, data: Buffer): string {
  const body = data.toString('base64')
  return `${SEALED_V1}${keyId ?? NO_KEY_ID}:${digestOf(body)}:${body}\n`
}

function parseSealed(text: string): { keyId?: string; data: Buffer } | null {
  const parts = text.slice(SEALED_V1.length).replace(/\r?\n$/, '').split(':')
  if (parts.length !== 3) return null
  const [keyId, digest, body] = parts
  if (!keyId || !body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0 || digestOf(body) !== digest) return null
  return { keyId: keyId === NO_KEY_ID ? undefined : keyId, data: Buffer.from(body, 'base64') }
}

function isSealed(text: string): boolean {
  return text.startsWith(SEALED_PREFIX)
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

async function readRaw(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function backupsOf(file: string): Promise<string[]> {
  const prefix = `${basename(file)}${BACKUP_MARK}`
  try {
    return (await readdir(dirname(file))).filter((name) => name.startsWith(prefix) && name.endsWith('.bak')).sort().map((name) => join(dirname(file), name))
  } catch {
    return []
  }
}

export function backupCreatedAt(path: string, fallback: number): number {
  const match = /\.plaintext-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]+\.bak$/.exec(path)
  if (!match) return fallback
  const [, y, mo, d, h, mi, s] = match
  const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  return Number.isFinite(time) ? time : fallback
}

async function readState(dir: string): Promise<VaultState> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')) as Partial<VaultState> | null
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
      const files: VaultState['files'] = {}
      for (const [name, entry] of Object.entries(parsed.files)) {
        const okStarts = Number(entry?.okStarts)
        if (Number.isInteger(okStarts) && okStarts >= 0) files[name] = { okStarts, updatedAt: String(entry?.updatedAt ?? '') }
      }
      return { version: 1, files }
    }
  } catch {
  }
  return { version: 1, files: {} }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function legacyCopiesOf(file: string): Promise<string[]> {
  const name = escapeRegExp(basename(file))
  const patterns = [
    new RegExp(`^${name}\\.corrupt\\.bak$`),
    new RegExp(`^${name}\\.corrupt-\\d+\\.bak$`),
    new RegExp(`^${name}\\.[0-9a-f]{16}\\.corrupt$`),
    new RegExp(`^${name}\\.\\d+\\.tmp$`),
    new RegExp(`^${name}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`),
    new RegExp(`^${name}\\.[0-9a-f-]{36}\\.bak$`)
  ]
  try {
    return (await readdir(dirname(file))).filter((entry) => patterns.some((pattern) => pattern.test(entry))).sort().map((entry) => join(dirname(file), entry))
  } catch {
    return []
  }
}

function lockedBy(locks: Map<string, Promise<unknown>>) {
  return <T>(file: string, work: () => Promise<T>): Promise<T> => {
    const key = fileKey(file)
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.catch(() => undefined)
    locks.set(key, settled)
    void settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key)
    })
    return next
  }
}

function fileKey(file: string): string {
  return process.platform === 'win32' ? file.toLowerCase() : file
}

async function createEmptyFile(file: string, mode: number): Promise<void> {
  const handle = await openFile(file, 'wx', mode)
  await handle.close()
}

type Reason = 'unavailable' | 'decrypt' | 'key-changed' | 'corrupt' | 'format'
type SealPlan = { seal: false } | { seal: true; keyId?: string }

export function createCredentialVault(deps: CredentialVaultDeps): CredentialVault {
  const locked = lockedBy(new Map())
  const held = new Map<string, string>()
  const io: CredentialVaultIo = {
    atomicWrite: deps.io?.atomicWrite ?? ((file, content) => atomicWriteFile(file, content, { mode: 0o600, durable: true })),
    createEmpty: deps.io?.createEmpty ?? createEmptyFile
  }
  let warnedUnavailable = false
  let warnedKeyPending = false
  const now = deps.now ?? Date.now
  const stateLocks = lockedBy(new Map())

  const countStart = (file: string, ok: boolean): Promise<number> =>
    stateLocks(join(dirname(file), STATE_FILE), async () => {
      const state = await readState(dirname(file))
      const name = basename(file)
      const before = state.files[name]?.okStarts ?? 0
      const okStarts = ok ? Math.min(before + 1, 1000) : 0
      if (before === okStarts && state.files[name]) return okStarts
      state.files[name] = { okStarts, updatedAt: new Date(now()).toISOString() }
      try {
        await atomicWriteFile(join(dirname(file), STATE_FILE), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
      } catch (error) {
        await deps.log(file, `state-failed ${file} ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!ok && before > 0) await deps.log(file, `stable-reset ${file} (successful-start count cleared)`)
      return okStarts
    })

  const pruneBackups = async (file: string, okStarts: number): Promise<void> => {
    if (okStarts < STABLE_STARTS) return
    for (const copy of await backupsOf(file)) {
      let created: number
      try {
        created = backupCreatedAt(copy, (await stat(copy)).mtimeMs)
      } catch {
        continue
      }
      if (now() - created < BACKUP_MIN_AGE_MS) continue
      try {
        await rm(copy)
        await deps.log(file, `backup-deleted ${copy} (encryption stable: ${okStarts} successful starts in a row, backup older than 7 days)`)
      } catch (error) {
        await deps.log(file, `backup-delete-failed ${copy} ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const unreadable = async (file: string, reason: Reason, detail = ''): Promise<CredentialVaultError> => {
    const backups = await backupsOf(file)
    const restore = backups.length
      ? pick(`可以用同目录下的明文备份恢复（先退出砚，把备份复制成原文件名）：${backups.join('；')}。`, `You can restore from the plaintext backup in the same folder (quit Inkstone, then copy it over the original name): ${backups.join('; ')}.`)
      : pick('这个文件没有迁移前的明文备份。', 'There is no pre-migration plaintext backup for this file.')
    const extra = detail ? pick(`；${detail}`, `; ${detail}`) : ''
    const why = reason === 'format'
      ? pick('文件由更新版本的砚写入，当前版本不认识这种格式', 'the file was written by a newer Inkstone version in a format this version does not know')
      : reason === 'unavailable'
        ? pick('系统加密（safeStorage/DPAPI）当前不可用', 'system encryption (safeStorage/DPAPI) is not available right now')
        : reason === 'key-changed'
          ? pick(`加密密钥已变化：文件是用另一把密钥加密的，当前应用数据目录的 Local State 里已经不是那把密钥（换了电脑或 Windows 用户、便携版在别的电脑上用过、应用数据目录被删除或换成另一个，例如开发版和安装版各用各的）${extra}`, `the encryption key has changed: the file was encrypted with a key that is no longer in this app data folder's Local State (another computer or Windows user, a portable copy used elsewhere, or a deleted or different app data folder such as dev versus installed builds)${extra}`)
          : reason === 'corrupt'
            ? pick(`文件已损坏：密文不完整或格式不对${extra}`, `the file is damaged: the ciphertext is incomplete or malformed${extra}`)
            : pick(`解密失败${extra}`, `decryption failed${extra}`)
    await deps.log(file, `read-failed ${reason} ${file}${detail ? ` (${detail})` : ''}`)
    if (reason !== 'unavailable') await countStart(file, false).catch(() => undefined)
    const message = pick(`凭据文件已加密，但无法读取（${why}）：${file}。文件保持原样，没有被清空或覆盖。${restore}也可以把这个文件移走后重新登录或重新填写这些凭据。`, `The credentials file is encrypted but cannot be read (${why}): ${file}. The file was left untouched. ${restore} Or move this file away, then sign in or enter these credentials again.`)
    return new CredentialVaultError(message, file, backups)
  }

  const open = async (file: string, raw: string): Promise<{ text: string; stale: boolean; keyId?: string }> => {
    if (!raw.startsWith(SEALED_V1)) throw await unreadable(file, 'format')
    const parsed = parseSealed(raw)
    if (!parsed) throw await unreadable(file, 'corrupt')
    if (!(await deps.cipher.available())) throw await unreadable(file, 'unavailable')
    if (deps.cipher.keyId && parsed.keyId) {
      const current = await deps.cipher.keyId()
      if (current === undefined) throw await unreadable(file, 'unavailable', 'Local State could not be read')
      if (parsed.keyId !== current) throw await unreadable(file, 'key-changed', `file ${parsed.keyId}, Local State ${current}`)
    }
    try {
      return { ...(await deps.cipher.decrypt(parsed.data)), keyId: parsed.keyId }
    } catch (error) {
      throw await unreadable(file, 'decrypt', error instanceof Error ? error.message : String(error))
    }
  }

  const plan = async (file: string): Promise<SealPlan> => {
    if (deps.plaintext()) return { seal: false }
    if (!(await deps.cipher.available())) {
      if (!warnedUnavailable) {
        warnedUnavailable = true
        await deps.log(file, 'plaintext-fallback safeStorage is not available; credentials stay in plaintext')
      }
      return { seal: false }
    }
    if (!deps.cipher.keyId) return { seal: true }
    const keyId = await deps.cipher.keyId()
    if (keyId) return { seal: true, keyId }
    if (!warnedKeyPending) {
      warnedKeyPending = true
      await deps.log(file, 'plaintext-pending Local State on disk has no os_crypt.encrypted_key yet; credentials stay in plaintext until a later write or restart')
    }
    return { seal: false }
  }

  const encode = async (file: string, text: string, keyId: string | undefined): Promise<string | null> => {
    try {
      return formatSealed(keyId, await deps.cipher.encrypt(text))
    } catch (error) {
      await deps.log(file, `encrypt-failed ${file} ${error instanceof Error ? error.message : String(error)}; written in plaintext`)
      return null
    }
  }

  const backup = async (file: string): Promise<boolean> => {
    const target = `${file}${BACKUP_MARK}${timestamp()}-${randomBytes(3).toString('hex')}.bak`
    let created = false
    try {
      const info = await stat(file)
      const bytes = await readFile(file)
      await io.createEmpty(target, 0o600)
      created = true
      if (deps.restrict) {
        await deps.restrict(target).then(
          () => deps.log(file, `backup-acl ${target} limited to the current user`),
          (error: unknown) => deps.log(file, `backup-acl-failed ${target} ${error instanceof Error ? error.message : String(error)}`)
        )
      }
      await writeFile(target, bytes, { flag: 'r+' })
      await chmod(target, info.mode & 0o777)
      await deps.log(file, `backup ${file} -> ${target} (plaintext copy kept for recovery; delete it once the encrypted file works)`)
      return true
    } catch (error) {
      if (created) await rm(target, { force: true }).catch(() => undefined)
      await deps.log(file, `backup-failed ${file} ${error instanceof Error ? error.message : String(error)}; kept in plaintext`)
      return false
    }
  }

  const store = async (file: string, current: string | null, text: string, target: SealPlan): Promise<void> => {
    let content = target.seal ? await encode(file, text, target.keyId) : null
    const migrating = content !== null && current !== null && !isSealed(current)
    if (migrating && !(await backup(file))) content = null
    await io.atomicWrite(file, content ?? text)
    if (content === null || !migrating) return
    await deps.log(file, `sealed ${file}`)
    for (const copy of await legacyCopiesOf(file)) await deps.log(file, `legacy-copy ${copy} (older copy that may hold plaintext credentials; left in place)`)
  }

  const put = async (file: string, text: string, force: boolean, background = false): Promise<void> => {
    await mkdir(dirname(file), { recursive: true })
    const current = await readRaw(file)
    let existing: { text: string; stale: boolean; keyId?: string } | null = current === null ? null : { text: current, stale: false }
    if (current !== null && isSealed(current)) {
      try {
        existing = await open(file, current)
      } catch (error) {
        if (!(error instanceof CredentialVaultError)) throw error
        if (background) {
          held.set(fileKey(file), text)
          await deps.log(file, `write-held ${file} (background update kept in memory until the file can be read again)`)
          throw error
        }
        await deps.log(file, `write-refused ${file} (change requested by the user was not saved)`)
        throw new CredentialVaultError(pick(`这次修改未保存。${error.message}`, `This change was not saved. ${error.message}`), error.file, error.backups)
      }
    }
    const target = await plan(file)
    const sameForm = current !== null && (isSealed(current) ? target.seal && existing?.keyId === target.keyId : !target.seal)
    if (!force && existing && existing.text === text && !existing.stale && sameForm) {
      held.delete(fileKey(file))
      return
    }
    await store(file, current, text, target)
    held.delete(fileKey(file))
  }

  return {
    async read(file) {
      const raw = await readRaw(file)
      const key = fileKey(file)
      if (raw === null) {
        if (held.delete(key)) await deps.log(file, `held-dropped ${file} (file was removed)`)
        return null
      }
      let text = raw
      let stale = false
      if (isSealed(raw)) ({ text, stale } = await open(file, raw))
      const pending = held.get(key)
      if (pending !== undefined) {
        const wrote = await locked(file, async () => {
          if (held.get(key) !== pending) return false
          await put(file, pending, true, true)
          return true
        })
        if (wrote) {
          await deps.log(file, `held-written ${file}`)
          return pending
        }
        const latest = await readRaw(file)
        if (latest === null) return null
        return isSealed(latest) ? (await open(file, latest)).text : latest
      }
      if (stale) {
        await locked(file, async () => {
          if ((await readRaw(file)) !== raw) return
          await put(file, text, true)
        }).catch(() => undefined)
      }
      return text
    },
    write(file, text, options = {}) {
      return locked(file, () => put(file, text, false, options.background === true))
    },
    async sweep(files) {
      for (const file of files) {
        const decrypted = await locked(file, async (): Promise<boolean> => {
          const current = await readRaw(file)
          if (current === null) return false
          if (isSealed(current)) {
            const opened = await open(file, current)
            if (deps.plaintext()) {
              await io.atomicWrite(file, opened.text)
              await deps.log(file, `unsealed ${file} (plaintext mode: YAN_PLAINTEXT_CREDENTIALS, ${PLAINTEXT_ARG} or portable build)`)
              return false
            }
            if (!opened.stale) return true
            const target = await plan(file)
            await store(file, current, opened.text, target)
            await deps.log(file, `resealed ${file}`)
            return true
          }
          try {
            JSON.parse(current)
          } catch {
            await deps.log(file, `skipped ${file} (not JSON)`)
            return false
          }
          await store(file, current, current, await plan(file))
          return false
        }).catch(async (error) => {
          if (!(error instanceof CredentialVaultError)) await deps.log(file, `sweep-failed ${file} ${error instanceof Error ? error.message : String(error)}`)
          return null
        })
        if (decrypted === null) continue
        const okStarts = await countStart(file, decrypted).catch(() => 0)
        if (decrypted) await pruneBackups(file, okStarts)
      }
    },
    async backups(files) {
      return (await Promise.all(files.map(backupsOf))).flat()
    },
    async removeBackups(files, remove) {
      const removed: string[] = []
      const failed: string[] = []
      const skipped: string[] = []
      for (const file of files) {
        const copies = await backupsOf(file)
        if (!copies.length) continue
        const raw = await readRaw(file).catch(() => null)
        if (raw !== null && isSealed(raw) && !(await open(file, raw).then(() => true, () => false))) {
          skipped.push(...copies)
          await deps.log(file, `backup-kept ${file} (the encrypted file cannot be read right now, so its ${copies.length} plaintext backup(s) were not deleted)`)
          continue
        }
        for (const copy of copies) {
          try {
            await remove(copy)
            removed.push(copy)
            await deps.log(file, `backup-deleted ${copy} (removed by the user from Settings)`)
          } catch (error) {
            failed.push(copy)
            await deps.log(file, `backup-delete-failed ${copy} ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return { removed, failed, skipped }
    }
  }
}

async function logLine(file: string, line: string): Promise<void> {
  console.warn(`[credential-vault] ${line}`)
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(join(dirname(file), LOG_FILE), `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
  }
}

export const credentialVault = createCredentialVault({
  cipher: safeStorageCipher(electronSafeStorage, electronKeyId),
  restrict: restrictToCurrentUser,
  plaintext: () => plaintextCredentialsRequested(),
  log: logLine
})

export function readCredentialFile(file: string): Promise<string | null> {
  return credentialVault.read(file)
}

export function writeCredentialFile(file: string, text: string, options: { background?: boolean } = {}): Promise<void> {
  return credentialVault.write(file, text, options)
}

export function listCredentialBackups(dir: string = YAN_DIR): Promise<string[]> {
  return credentialVault.backups(credentialFilesIn(dir))
}

export function removeCredentialBackups(remove: (file: string) => Promise<void>, dir: string = YAN_DIR): Promise<{ removed: string[]; failed: string[]; skipped: string[] }> {
  return credentialVault.removeBackups(credentialFilesIn(dir), remove)
}

export async function sweepCredentialFiles(dir: string = YAN_DIR): Promise<void> {
  if (PORTABLE_DATA_DIR) await logLine(join(dir, LOG_FILE), 'portable build: credentials are kept in plaintext because DPAPI keys do not travel with the portable folder')
  await credentialVault.sweep(credentialFilesIn(dir))
}
