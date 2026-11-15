import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const fingerprint = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16)
const DAY = 24 * 60 * 60 * 1000

function fakeSafeStorage() {
  const state = { available: true, failDecrypt: false, stale: false, encrypts: 0, decrypts: 0 }
  const scramble = (buffer) => Buffer.from(buffer.map((byte, index) => byte ^ (0x5a + (index % 7))))
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => state.available,
    encryptStringAsync: async (text) => {
      if (!state.available) throw new Error('encryption unavailable')
      state.encrypts++
      return Buffer.concat([Buffer.from('FAKE1'), scramble(Buffer.from(text, 'utf8'))])
    },
    decryptStringAsync: async (data) => {
      state.decrypts++
      if (!state.available || state.failDecrypt) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      const buffer = Buffer.from(data)
      if (buffer.subarray(0, 5).toString() !== 'FAKE1') throw new Error('bad header')
      return { result: scramble(buffer.subarray(5)).toString('utf8'), shouldReEncrypt: state.stale }
    }
  }
  return { state, safeStorage }
}

const electronStub = {
  name: 'fake-electron',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake-electron' }))
    b.onLoad({ filter: /.*/, namespace: 'fake-electron' }, () => ({
      contents: 'const e = globalThis.__fakeElectron; export const app = e.app; export const safeStorage = e.safeStorage; export const net = e.net; export const shell = e.shell; export default e;'
    }))
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function errorOf(work) {
  try {
    await work()
    return null
  } catch (error) {
    return error
  }
}

function aclEntries(path) {
  const acl = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [path], { encoding: 'utf8', windowsHide: true })
  return { acl, entries: acl.split(/\r?\n/).map((line) => line.replace(path, '').trim()).filter((line) => /:\(/.test(line)) }
}

async function storeTests(ok, compile, root) {
  const piDir = join(root, 'pi')
  const yanDir = join(root, 'yan')
  await mkdir(piDir, { recursive: true })
  await mkdir(yanDir, { recursive: true })
  process.env.YAN_PI_DIR = piDir
  process.env.YAN_DATA_DIR = yanDir
  delete process.env.YAN_PLAINTEXT_CREDENTIALS
  delete process.env.PORTABLE_EXECUTABLE_DIR
  process.env.CODEX_HOME = join(root, 'codex-home')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-home')
  const fake = fakeSafeStorage()
  const userData = join(root, 'electron')
  await mkdir(userData, { recursive: true })
  globalThis.__fakeElectron = {
    app: { whenReady: async () => undefined, getPath: (name) => (name === 'userData' ? userData : root) },
    safeStorage: fake.safeStorage,
    shell: { openExternal: async () => undefined, trashItem: async () => undefined },
    net: { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) }
  }
  const m = await compile(null, {
    stdin: {
      contents: [
        "export * as pool from './src/main/api-key-pool'",
        "export * as codex from './src/main/codex-accounts'",
        "export * as oauth from './src/main/oauth-accounts'",
        "export * as image from './src/main/image-config'",
        "export * as search from './src/main/search/config'",
        "export * as relay from './src/main/relay-bridge/store'",
        "export * as quota from './src/main/account-quota'",
        "export * as vault from './src/main/credential-vault'",
        "export * from './src/shared/credential-vault'"
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    plugins: [electronStub]
  })
  const authFile = join(piDir, 'auth.json')
  const raw = (name) => readFile(join(yanDir, name), 'utf8')
  const logText = () => readFile(join(yanDir, 'credential-vault.log'), 'utf8')

  ok((await m.search.setSearchKey('context7', 'ctx-pending-0000')).ok, 'Local State 还没落盘时写入照常成功')
  ok((await raw('search-config.json')).includes('ctx-pending-0000'), 'Local State 磁盘上没有 os_crypt 密钥时这次仍写明文')
  ok((await m.search.setSearchKey('context7', 'ctx-pending-0001')).ok && (await raw('search-config.json')).includes('ctx-pending-0001'), '密钥仍未落盘时继续明文')
  ok((await logText()).split('\n').filter((line) => line.includes('plaintext-pending')).length === 1, '密钥未落盘只记一次日志')
  const localKey = 'RFBBUEkAAAA='
  await writeFile(join(userData, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: localKey } }))

  const apiKey = 'sk-vault-test-AAAA1111'
  ok((await m.pool.addApiKey('deepseek', apiKey, '测试')).ok, '添加 API key 成功')
  ok(!(await raw('api-keys.json')).includes(apiKey), 'api-keys.json 落盘不含明文 key')
  ok((await raw('api-keys.json')).startsWith(`inkstone-sealed:v1:${fingerprint(localKey)}:`), '密文头记录 Local State 里 encrypted_key 的指纹')
  ok(JSON.parse(await readFile(authFile, 'utf8')).deepseek.key === apiKey, 'pi 的 auth.json 仍按原生明文格式写入')
  ok((await m.pool.listApiKeyPools()).deepseek?.length === 1, '加密后的 key 列表能正常读回')

  const codexAccess = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-vault', chatgpt_user_id: 'user-vault' }, 'https://api.openai.com/profile': { email: 'vault@example.com' } })
  const codexRefresh = 'codex-refresh-SECRET-2222'
  const auth = JSON.parse(await readFile(authFile, 'utf8'))
  auth['openai-codex'] = { type: 'oauth', access: codexAccess, refresh: codexRefresh, expires: Date.now() + 3600_000, accountId: 'acct-vault' }
  const xaiAccess = jwt({ sub: 'xai-user', email: 'x@example.com' })
  auth.xai = { type: 'oauth', access: xaiAccess, refresh: 'xai-refresh-SECRET-3333', expires: Date.now() + 3600_000 }
  await writeFile(authFile, JSON.stringify(auth))
  ok(!!(await m.codex.captureActiveCodexAccount()), '保存当前 ChatGPT 账号')
  const codexRaw = await raw('codex-accounts.json')
  ok(!codexRaw.includes(codexRefresh) && !codexRaw.includes(codexAccess), 'codex-accounts.json 落盘不含 access/refresh')
  ok((await m.codex.listCodexAccounts()).length === 1, '加密后的 ChatGPT 账号能读回')
  ok(!!(await m.oauth.captureActiveOAuthAccount('xai')), '保存当前 xAI 订阅账号')
  const oauthRaw = await raw('oauth-accounts.json')
  ok(!oauthRaw.includes('xai-refresh-SECRET-3333') && !oauthRaw.includes(xaiAccess), 'oauth-accounts.json 落盘不含 access/refresh')
  ok((await m.oauth.listOAuthAccounts()).xai?.length === 1, '加密后的订阅账号能读回')
  const encryptsBefore = fake.state.encrypts
  await m.oauth.captureActiveOAuthAccount('xai')
  ok(fake.state.encrypts === encryptsBefore && (await raw('oauth-accounts.json')) === oauthRaw, '内容没变时不重写文件')

  const imageKey = 'sk-image-SECRET-4444'
  ok((await m.image.setImageKey('openai', imageKey)).ok, '保存生图 key')
  ok(!(await raw('image-config.json')).includes(imageKey), 'image-config.json 落盘不含明文 key')
  await m.image.refreshImageConfig()
  ok(m.image.imageFileKey('openai') === imageKey, '生图 key 能读回')

  const searchKey = 'tvly-SECRET-5555'
  ok((await m.search.setSearchKey('tavily', searchKey)).ok, '保存搜索 key')
  ok(!(await raw('search-config.json')).includes(searchKey), 'search-config.json 落盘不含明文 key')
  ok((await m.search.resolveSearchKey('tavily')) === searchKey, '搜索 key 能读回')

  const relay = new m.relay.RelayBridgeStore(yanDir)
  const secret = await relay.secret()
  const relayRaw = await raw('relay-bridge.json')
  ok(!relayRaw.includes(secret) && !relayRaw.includes('"d"'), 'relay-bridge.json 落盘不含中继密钥与主机私钥')
  ok((await new m.relay.RelayBridgeStore(yanDir).secret()) === secret, '重新打开中继存储读回同一密钥')

  const legacy = { version: 1, providers: { openai: [{ id: 'k1', label: '旧', key: 'sk-legacy-PLAIN-6666', addedAt: 1 }] } }
  const legacyText = JSON.stringify(legacy, null, 2) + '\n'
  await writeFile(join(yanDir, 'api-keys.json'), legacyText)
  await chmod(join(yanDir, 'api-keys.json'), 0o600).catch(() => undefined)
  const legacyMode = (await stat(join(yanDir, 'api-keys.json'))).mode
  ok((await m.pool.listApiKeyPools()).openai?.length === 1, '旧明文 api-keys.json 照常读取')
  ok((await raw('api-keys.json')) === legacyText, '只读取时不改写旧明文文件')
  ok((await m.pool.renameApiKey('openai', 'k1', '改名')).ok, '旧明文文件上做一次写入')
  ok(!(await raw('api-keys.json')).includes('sk-legacy-PLAIN-6666'), '下次写入后旧明文文件转成密文')
  const backups = (await readdir(yanDir)).filter((name) => name.startsWith('api-keys.json.plaintext-') && name.endsWith('.bak'))
  ok(backups.length === 1, '改写前在同目录留下带时间戳的明文备份', backups.join(','))
  const backupPath = join(yanDir, backups[0])
  ok((await readFile(backupPath, 'utf8')) === legacyText, '备份内容与原文件一致')
  const log = await logText()
  ok(log.includes(backupPath), '备份路径记进日志')
  if (process.platform === 'win32') {
    ok(log.includes(`backup-acl ${backupPath}`), '备份权限收紧到当前用户并记日志', log)
    const { acl, entries } = aclEntries(backupPath)
    const me = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), { encoding: 'utf8', windowsHide: true }).trim().toLowerCase()
    ok(entries.length === 1 && !entries[0].includes('(I)') && entries[0].toLowerCase().startsWith(`${me}:(f)`), 'Windows 上备份的 ACL 只有当前用户一条、非继承的完全控制', `${me}\n${acl}`)
  } else {
    ok((await stat(backupPath)).mode === legacyMode, '备份权限与原文件一致')
  }
  ok(!log.includes('sk-legacy-PLAIN-6666') && !log.includes(apiKey), '日志不含密钥')
  ok((await m.pool.renameApiKey('openai', 'k1', '再改')).ok && (await readdir(yanDir)).filter((name) => name.startsWith('api-keys.json.plaintext-')).length === 1, '已是密文时再写入不再重复备份')
  const allBackups = (await readdir(yanDir)).filter((name) => name.includes('.json.plaintext-') && name.endsWith('.bak'))
  ok((await m.vault.listCredentialBackups(yanDir)).length === allBackups.length && allBackups.length === 2, '设置页能列出明文备份数量（api-keys 与 search-config 各一份）', allBackups.join(','))

  const sealedBefore = await raw('api-keys.json')
  let parsedSealed = true
  try { JSON.parse(sealedBefore) } catch { parsedSealed = false }
  ok(!parsedSealed, '密文文件不是 JSON，旧版本读到会按损坏拒绝写入而不是当成空列表')
  fake.state.failDecrypt = true
  const listError = (await errorOf(() => m.pool.listApiKeyPools()))?.message ?? ''
  ok(listError.includes('api-keys.json') && /解密|decrypt/i.test(listError), '解密失败时报出明确错误并指明文件', listError)
  ok(listError.includes(backups[0]), '错误里给出可恢复的备份路径', listError)
  const add = await m.pool.addApiKey('openai', 'sk-should-not-write')
  ok(!add.ok, '解密失败时拒绝写入 key 列表')
  ok((await raw('api-keys.json')) === sealedBefore, '解密失败时不清空、不覆盖原文件')
  const imageBefore = await raw('image-config.json')
  ok(!(await m.image.setImageKey('google', 'g-key-should-not-write')).ok, '解密失败时生图配置拒绝写入')
  ok((await raw('image-config.json')) === imageBefore, '生图配置原文件不变')
  const searchBefore = await raw('search-config.json')
  ok(!(await m.search.setSearchKey('brave', 'brave-should-not-write')).ok, '解密失败时搜索配置拒绝写入')
  ok((await raw('search-config.json')) === searchBefore, '搜索配置原文件不变')
  const codexBefore = await raw('codex-accounts.json')
  ok(!(await m.codex.clearCodexAccounts()).ok && (await raw('codex-accounts.json')) === codexBefore, '解密失败时清空账号也被拒绝，原文件不变')
  const oauthBefore = await raw('oauth-accounts.json')
  const authBefore = await readFile(authFile, 'utf8')
  const captureError = await errorOf(() => m.oauth.captureActiveOAuthAccount('xai'))
  ok(captureError?.name === 'CredentialVaultError', '订阅账号文件解不开时保存当前账号报凭据错误', String(captureError))
  const oauthKey = (await m.oauth.oauthAccountTargets('xai').catch(() => []))[0]?.key ?? 'oauth:xai:any'
  const switched = await m.oauth.switchOAuthAccount('xai', oauthKey)
  ok(!switched.ok && /oauth-accounts\.json/.test(switched.error ?? ''), '订阅账号文件解不开时切换账号被拒绝并指明文件', JSON.stringify(switched))
  ok((await raw('oauth-accounts.json')) === oauthBefore && (await readFile(authFile, 'utf8')) === authBefore, '切换被拒时订阅账号文件与 auth.json 都不变')
  const relayError = (await errorOf(() => new m.relay.RelayBridgeStore(yanDir).secret()))?.message ?? ''
  ok(/relay-bridge\.json/.test(relayError), '中继存储解密失败时报错，不重新生成密钥', relayError)
  let ipcError = ''
  try { await m.codex.listCodexAccounts() } catch (error) { ipcError = `Error invoking remote method 'yan:codexAccounts': ${error.name}: ${error.message}` }
  ok(m.credentialVaultMessage(new Error(ipcError)) === ipcError.slice(ipcError.indexOf('CredentialVaultError: ') + 22), '界面从 IPC 错误里认出凭据解密失败并取出完整说明', ipcError)
  ok(m.credentialVaultMessage(new Error("Error invoking remote method 'yan:apiKeys': Error: EACCES")) === null && m.credentialVaultMessage(undefined) === null, '其他错误不当成凭据解密失败')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 404 })
  try {
    m.quota.invalidateAccountQuotaReport()
    const brokenReport = await m.quota.accountQuotaReport()
    ok(brokenReport.credentialProblem === true, '额度报告标出账号凭据读取失败，不再静默', JSON.stringify(brokenReport))
    fake.state.failDecrypt = false
    m.quota.invalidateAccountQuotaReport()
    const fineReport = await m.quota.accountQuotaReport()
    ok(fineReport.credentialProblem === undefined, '能解密时额度报告不带这个标记')
  } finally {
    globalThis.fetch = realFetch
  }
  fake.state.failDecrypt = false

  const imagePath = join(yanDir, 'image-config.json')
  const imageSealed = await raw('image-config.json')
  await rm(imagePath)
  await mkdir(imagePath)
  const dirResult = await m.image.setImageKey('google', 'g-key-dir')
  ok(!dirResult.ok && /EISDIR|EPERM|illegal operation|directory/i.test(dirResult.error ?? ''), '生图配置读到非「不存在」的错误（路径是目录）时拒绝写入，不当空配置', JSON.stringify(dirResult))
  ok((await stat(imagePath)).isDirectory(), '出错时不动原路径')
  await rm(imagePath, { recursive: true })
  await writeFile(imagePath, '{"keys":{"openai":"sk-half')
  const corruptResult = await m.image.setImageKey('google', 'g-key-corrupt')
  ok(!corruptResult.ok && corruptResult.error?.includes('image-config.json'), '生图配置 JSON 损坏时拒绝写入并指明文件', JSON.stringify(corruptResult))
  ok((await raw('image-config.json')) === '{"keys":{"openai":"sk-half', '生图配置损坏时原文件不变')
  ok((await raw('image-config.json.corrupt.bak')) === '{"keys":{"openai":"sk-half', '生图配置损坏时留 .corrupt.bak 副本')
  await m.image.refreshImageConfig()
  ok(m.image.imageFileKey('openai') === undefined, '只读刷新遇到损坏文件仍按空配置显示，不抛错')
  await writeFile(imagePath, imageSealed)
  const searchPath = join(yanDir, 'search-config.json')
  const searchSealed = await raw('search-config.json')
  await writeFile(searchPath, '[1,2]')
  const searchCorrupt = await m.search.setSearchKey('brave', 'brave-corrupt')
  ok(!searchCorrupt.ok && (await raw('search-config.json')) === '[1,2]' && (await raw('search-config.json.corrupt.bak')) === '[1,2]', '搜索配置不是对象时拒绝写入、原文件不变并留 .corrupt.bak', JSON.stringify(searchCorrupt))
  await writeFile(searchPath, searchSealed)

  fake.state.available = false
  const unavailableError = (await errorOf(() => m.pool.listApiKeyPools()))?.message ?? ''
  ok(/api-keys\.json/.test(unavailableError), '读到密文但加密不可用时报错', unavailableError)
  ok((await raw('api-keys.json')) === sealedBefore, '加密不可用时密文文件保持原样')
  await writeFile(join(yanDir, 'search-config.json'), JSON.stringify({ braveKey: 'brave-plain-7777' }))
  ok((await m.search.setSearchKey('tavily', 'tvly-plain-8888')).ok, '加密不可用时新写入照常成功（不掉登录）')
  ok((await raw('search-config.json')).includes('tvly-plain-8888'), '加密不可用时退回明文保存')
  ok((await m.search.resolveSearchKey('tavily')) === 'tvly-plain-8888', '明文退回后能读回')
  ok((await logText()).split('\n').filter((line) => line.includes('plaintext-fallback')).length === 1, '加密不可用只记一次警告')
  fake.state.available = true
}

async function vaultTests(ok, compile, root) {
  const dir = join(root, 'vault')
  await mkdir(dir, { recursive: true })
  const v = await compile(null, {
    stdin: { contents: "export * from './src/main/credential-vault'\nexport { atomicWriteFile } from './src/main/atomic-write'", resolveDir: process.cwd(), loader: 'ts' },
    plugins: [electronStub]
  })
  const KEY_A = 'aaaaaaaaaaaaaaaa'
  const KEY_B = 'bbbbbbbbbbbbbbbb'
  const make = (options = {}) => {
    const fake = options.fake ?? fakeSafeStorage()
    const lines = []
    const state = { keyId: options.keyId ?? KEY_A, plaintext: false }
    const vault = v.createCredentialVault({
      cipher: v.safeStorageCipher(async () => fake.safeStorage, async () => state.keyId),
      plaintext: () => state.plaintext,
      log: (file, line) => lines.push(line),
      ...(options.restrict ? { restrict: options.restrict } : {}),
      ...(options.io ? { io: options.io } : {}),
      ...(options.now ? { now: options.now } : {})
    })
    return { vault, fake, lines, state }
  }
  const { vault, fake, lines, state } = make()
  const file = join(dir, 'a.json')
  const other = join(dir, 'b.json')
  const broken = join(dir, 'c.json')
  const missing = join(dir, 'missing.json')

  ok((await vault.read(missing)) === null, '文件不存在时读到 null')
  await writeFile(file, '{"k":"plain-a"}\n')
  await writeFile(other, '{"k":"plain-b"}\n')
  await writeFile(broken, '{not json')
  for (const leftover of ['a.json.corrupt.bak', 'a.json.corrupt-1731000000000.bak', 'a.json.0123456789abcdef.corrupt', 'a.json.4321.tmp', 'a.json.4321.0b5c7a1e-2f3d-4c5b-9a8e-1f2e3d4c5b6a.tmp', 'a.json.0b5c7a1e-2f3d-4c5b-9a8e-1f2e3d4c5b6a.bak']) {
    await writeFile(join(dir, leftover), '{"k":"old-plain"}')
  }
  ok((await vault.read(file)) === '{"k":"plain-a"}\n', '明文文件照常读取')

  await vault.sweep([file, other, broken, missing])
  ok(!(await readFile(file, 'utf8')).includes('plain-a') && !(await readFile(other, 'utf8')).includes('plain-b'), '启动迁移把明文凭据文件转成密文')
  ok((await readFile(file, 'utf8')).startsWith(`inkstone-sealed:v1:${KEY_A}:`), '密文头带当前密钥指纹')
  ok((await readFile(broken, 'utf8')) === '{not json', '迁移跳过不是 JSON 的文件，不动它')
  ok(!(await exists(missing)), '迁移不会凭空创建文件')
  ok((await vault.read(file)) === '{"k":"plain-a"}\n', '迁移后读回原文')
  ok(lines.filter((line) => line.startsWith('backup ')).length === 2, '每个被迁移的文件都记了备份日志')
  const legacyLines = lines.filter((line) => line.startsWith('legacy-copy '))
  ok(legacyLines.length === 6, '迁移时把旧版本留下的 6 类明文副本列进日志', legacyLines.join('\n'))
  ok((await readdir(dir)).filter((name) => name.startsWith('a.json.') && !name.includes('.plaintext-')).length === 6, '旧明文副本只记日志，不删除')

  const fresh = join(dir, 'fresh.json')
  await vault.write(fresh, '{"k":"fresh"}')
  ok(!(await readFile(fresh, 'utf8')).includes('fresh"'), '新文件直接写成密文')
  ok(!(await readdir(dir)).some((name) => name.startsWith('fresh.json.plaintext-')), '新文件没有旧明文，不产生备份')
  const encrypts = fake.state.encrypts
  await vault.write(fresh, '{"k":"fresh"}')
  ok(fake.state.encrypts === encrypts, '内容没变时跳过重写')

  const sealed = await readFile(file, 'utf8')
  await writeFile(file, sealed.replace(/^inkstone-sealed:v1:/, 'inkstone-sealed:v9:'))
  const newer = (await errorOf(() => vault.read(file)))?.message ?? ''
  ok(newer.length > 0 && (await readFile(file, 'utf8')).startsWith('inkstone-sealed:v9:'), '更新版本格式的密文报错且不改动', newer)
  ok(!!(await errorOf(() => vault.write(file, '{}'))) && (await readFile(file, 'utf8')).startsWith('inkstone-sealed:v9:'), '不认识的密文格式拒绝覆盖')
  for (const [label, damaged] of [['截断', sealed.slice(0, Math.floor(sealed.length / 2))], ['摘要不符', sealed.replace(/:([A-Za-z0-9+/=]+)\n$/, (all, body) => `:${body.slice(0, -4)}AAAA\n`)], ['缺字段', `inkstone-sealed:v1:${KEY_A}\n`]]) {
    await writeFile(file, damaged)
    const error = await errorOf(() => vault.read(file))
    ok(error instanceof v.CredentialVaultError && error.message.includes('文件已损坏') && !error.message.includes('密钥已变化'), `密文${label}时报「文件已损坏」而不是密钥变化`, error?.message)
    ok(!!(await errorOf(() => vault.write(file, '{"k":"x"}'))) && (await readFile(file, 'utf8')) === damaged, `密文${label}时拒绝覆盖`)
  }
  await writeFile(file, sealed)
  ok((await vault.read(file)) === '{"k":"plain-a"}\n' && !lines.some((line) => line.startsWith('write-held')), '用户发起的写入被拒后直接丢弃，不留在内存补写')
  const resealed = await readFile(file, 'utf8')

  fake.state.failDecrypt = true
  const failure = await errorOf(() => vault.read(file))
  ok(failure instanceof v.CredentialVaultError && failure.file === file && failure.message.includes('解密失败'), '解密失败抛出 CredentialVaultError')
  const userRefused = await errorOf(() => vault.write(file, '{"k":"user-change"}'))
  ok(userRefused instanceof v.CredentialVaultError && userRefused.message.includes('这次修改未保存') && (await readFile(file, 'utf8')) === resealed, '用户发起的写入被拒时错误写明「未保存」，原文件不变', userRefused?.message)
  ok(!!(await errorOf(() => vault.write(file, '{"k":"overwrite"}', { background: true }))) && (await readFile(file, 'utf8')) === resealed, '无法解密的密文文件拒绝覆盖（后台写入）')
  await vault.sweep([file])
  ok((await readFile(file, 'utf8')) === resealed, '迁移遇到无法解密的文件不改动')
  fake.state.failDecrypt = false
  ok((await vault.read(file)) === '{"k":"overwrite"}', '解开后先把之前被拒的那次写入补写上，读到的是新内容')
  ok(!(await readFile(file, 'utf8')).includes('overwrite') && lines.some((line) => line.startsWith('write-held')) && lines.some((line) => line.startsWith('held-written')), '后台写入被拒时留在内存，能解开时以密文补写并记日志；用户写入不补写')
  await vault.write(file, '{"k":"plain-a"}\n')

  state.keyId = KEY_B
  const changed = await errorOf(() => vault.read(file))
  ok(changed instanceof v.CredentialVaultError && changed.message.includes('加密密钥已变化') && fake.state.decrypts > 0, 'Local State 指纹变了报「加密密钥已变化」', changed?.message)
  const decryptsBefore = fake.state.decrypts
  await errorOf(() => vault.read(file))
  ok(fake.state.decrypts === decryptsBefore, '指纹不符时不去解密（避免把密钥问题说成别的）')
  const sealedA = await readFile(file, 'utf8')
  ok(!!(await errorOf(() => vault.write(file, '{"k":"new-refresh-token"}', { background: true }))) && (await readFile(file, 'utf8')) === sealedA, '密钥变化时拒绝写入，原文件不变')
  await vault.sweep([file])
  ok((await readFile(file, 'utf8')) === sealedA, '密钥变化时启动迁移也不动文件')
  state.keyId = KEY_A
  ok((await vault.read(file)) === '{"k":"new-refresh-token"}', '密钥恢复后补写被拒的新内容（新 refresh token 不丢）')
  await rm(file)
  state.keyId = KEY_B
  await vault.write(file, '{"k":"b"}')
  state.keyId = KEY_A
  await errorOf(() => vault.write(file, '{"k":"held-then-removed"}', { background: true }))
  await rm(file)
  ok((await vault.read(file)) === null && lines.some((line) => line.startsWith('held-dropped')), '文件被移走后丢弃内存里的待写内容并记日志')
  await vault.write(file, '{"k":"plain-a"}\n')

  let release = () => undefined
  let gate = null
  const gated = make({ fake, io: { atomicWrite: async (target, content) => {
    if (gate) await gate
    await v.atomicWriteFile(target, content, { mode: 0o600, durable: true })
  } } })
  gated.state.keyId = KEY_A
  const mixed = join(dir, 'interleave.json')
  await gated.vault.write(mixed, '{"v":"start"}')
  gated.state.keyId = KEY_B
  await errorOf(() => gated.vault.write(mixed, '{"v":"background-old"}', { background: true }))
  gated.state.keyId = KEY_A
  gate = new Promise((done) => { release = done })
  const userWrite = gated.vault.write(mixed, '{"v":"user-new"}')
  const reading = gated.vault.read(mixed)
  await new Promise((done) => setTimeout(done, 50))
  gate = null
  release()
  await userWrite
  await reading
  ok((await gated.vault.read(mixed)) === '{"v":"user-new"}', '读与写交错：读到待补写内容时写入已经抢先完成，补写在锁内复查后放弃，不覆盖新写入')
  fake.state.stale = true
  gate = new Promise((done) => { release = done })
  const userWrite2 = gated.vault.write(mixed, '{"v":"user-newer"}')
  const reading2 = gated.vault.read(mixed)
  await new Promise((done) => setTimeout(done, 50))
  gate = null
  release()
  await userWrite2
  await reading2
  fake.state.stale = false
  ok((await gated.vault.read(mixed)) === '{"v":"user-newer"}', '读与写交错：重新加密前重读文件，文件已变就不写回旧内容')

  fake.state.stale = true
  const staleBefore = fake.state.encrypts
  ok((await vault.read(file)) === '{"k":"plain-a"}\n' && fake.state.encrypts === staleBefore + 1, 'decrypt 要求重新加密时读取后重新加密写回')
  await vault.sweep([file])
  ok(lines.some((line) => line.startsWith(`resealed ${file}`)), '启动迁移遇到要求重新加密的文件会重写并记日志')
  fake.state.stale = false

  const unavailable = fakeSafeStorage()
  unavailable.state.available = false
  const warnLines = []
  const plainVault = v.createCredentialVault({ cipher: v.safeStorageCipher(async () => unavailable.safeStorage), plaintext: () => false, log: (f, line) => warnLines.push(line) })
  const plainFile = join(dir, 'plain-only.json')
  await plainVault.write(plainFile, '{"k":"p1"}')
  await plainVault.write(plainFile, '{"k":"p2"}')
  ok((await readFile(plainFile, 'utf8')) === '{"k":"p2"}', '加密不可用时写明文')
  ok(warnLines.filter((line) => line.includes('plaintext-fallback')).length === 1, '加密不可用只警告一次')
  const noneVault = v.createCredentialVault({ cipher: v.safeStorageCipher(async () => null), plaintext: () => false, log: () => undefined })
  await noneVault.write(plainFile, '{"k":"p3"}')
  ok((await readFile(plainFile, 'utf8')) === '{"k":"p3"}', '没有 Electron（纯 node）时写明文')
  const throwing = fakeSafeStorage()
  throwing.safeStorage.encryptStringAsync = async () => { throw new Error('boom') }
  const throwVault = v.createCredentialVault({ cipher: v.safeStorageCipher(async () => throwing.safeStorage, async () => KEY_A), plaintext: () => false, log: () => undefined })
  await throwVault.write(plainFile, '{"k":"p4"}')
  ok((await readFile(plainFile, 'utf8')) === '{"k":"p4"}', '加密调用异常时退回明文，写入不失败')

  state.plaintext = true
  await vault.sweep([file, other, fresh])
  ok((await readFile(file, 'utf8')) === '{"k":"plain-a"}\n' && (await readFile(other, 'utf8')) === '{"k":"plain-b"}\n', '明文模式下启动迁移把密文写回明文')
  ok(JSON.parse(await readFile(fresh, 'utf8')).k === 'fresh', '写回后是旧版本能读的 JSON')
  await vault.write(file, '{"k":"after-rollback"}')
  ok((await readFile(file, 'utf8')) === '{"k":"after-rollback"}', '明文模式下新写入是明文')
  ok(lines.some((line) => line.startsWith('unsealed')), '写回明文记日志')
  state.plaintext = false
  const before = (await readdir(dir)).filter((name) => name.startsWith('a.json.plaintext-')).length
  await vault.write(file, '{"k":"again"}')
  ok((await readdir(dir)).filter((name) => name.startsWith('a.json.plaintext-')).length === before + 1, '关闭明文模式后再次加密前重新备份明文')
  ok((await vault.read(file)) === '{"k":"again"}', '重新加密后读回一致')

  ok(await v.localStateKeyFingerprint(async () => JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEkx' } })) === fingerprint('RFBBUEkx'), 'Local State 指纹是 encrypted_key 的 sha256 前 16 位')
  ok((await v.localStateKeyFingerprint(async () => JSON.stringify({ browser: {} }))) === undefined, 'Local State 里没有 os_crypt 判为未落盘')
  ok((await v.localStateKeyFingerprint(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })) === undefined, 'Local State 文件不存在判为未落盘')
  ok((await v.localStateKeyFingerprint(async () => '{"os_crypt":')) === undefined, 'Local State 写到一半判为未落盘')
  const pending = make({ keyId: undefined })
  pending.state.keyId = undefined
  const pendingFile = join(dir, 'pending.json')
  await writeFile(pendingFile, '{"k":"pending-0"}')
  await pending.vault.sweep([pendingFile])
  await pending.vault.write(pendingFile, '{"k":"pending-1"}')
  ok((await readFile(pendingFile, 'utf8')) === '{"k":"pending-1"}', '密钥未落盘时迁移和写入都保持明文')
  ok(!(await readdir(dir)).some((name) => name.startsWith('pending.json.plaintext-')), '密钥未落盘时不产生备份')
  ok(pending.lines.filter((line) => line.startsWith('plaintext-pending')).length === 1, '密钥未落盘只记一次日志')
  pending.state.keyId = KEY_A
  await pending.vault.write(pendingFile, '{"k":"pending-2"}')
  ok((await readFile(pendingFile, 'utf8')).startsWith(`inkstone-sealed:v1:${KEY_A}:`) && (await pending.vault.read(pendingFile)) === '{"k":"pending-2"}', '密钥落盘后下次写入转成密文')

  const restrictedSizes = []
  const acl = make({ restrict: async (target) => { restrictedSizes.push((await stat(target)).size) } })
  const aclFile = join(dir, 'acl.json')
  await writeFile(aclFile, '{"k":"acl"}')
  await acl.vault.write(aclFile, '{"k":"acl-2"}')
  const aclBackup = (await readdir(dir)).find((name) => name.startsWith('acl.json.plaintext-'))
  ok(restrictedSizes.length === 1 && restrictedSizes[0] === 0, '先建空文件收紧权限，再写入备份内容')
  ok((await readFile(join(dir, aclBackup), 'utf8')) === '{"k":"acl"}', '收紧权限后写入的备份内容完整')
  ok(acl.lines.some((line) => line.startsWith(`backup-acl ${join(dir, aclBackup)}`)), '收紧权限记日志')
  const failAcl = make({ restrict: async () => { throw new Error('icacls denied') } })
  const failAclFile = join(dir, 'acl-fail.json')
  await writeFile(failAclFile, '{"k":"acl"}')
  await failAcl.vault.write(failAclFile, '{"k":"acl-3"}')
  ok((await readFile(failAclFile, 'utf8')).startsWith('inkstone-sealed:v1:') && failAcl.lines.some((line) => line.startsWith('backup-acl-failed') && line.includes('icacls denied')), '收紧权限失败只记日志，不阻断加密')
  ok(v.parseWhoamiSid('"win-pc\\someone","S-1-5-21-1111111111-2222222222-3333333333-1001"\r\n') === 'S-1-5-21-1111111111-2222222222-3333333333-1001' && v.parseWhoamiSid('nothing') === undefined, '从 whoami /user 输出取出当前用户 SID')

  const noBackup = make({ io: { createEmpty: async () => { throw new Error('disk full') } } })
  const noBackupFile = join(dir, 'no-backup.json')
  await writeFile(noBackupFile, '{"k":"nb"}')
  await noBackup.vault.write(noBackupFile, '{"k":"nb-2"}')
  ok((await readFile(noBackupFile, 'utf8')) === '{"k":"nb-2"}', '备份失败时这次退回明文写入')
  ok(noBackup.lines.some((line) => line.startsWith('backup-failed') && line.includes('disk full')) && !noBackup.lines.some((line) => line.startsWith('sealed')), '备份失败记日志，不加密')
  ok(!(await readdir(dir)).some((name) => name.startsWith('no-backup.json.plaintext-')), '备份失败不留半截备份')

  let crashOnce = true
  const crash = make({ io: { atomicWrite: async (target, content) => {
    if (crashOnce) {
      crashOnce = false
      throw new Error('simulated crash before rename')
    }
    await v.atomicWriteFile(target, content, { mode: 0o600, durable: true })
  } } })
  const crashFile = join(dir, 'crash.json')
  await writeFile(crashFile, '{"k":"before-crash"}')
  ok(!!(await errorOf(() => crash.vault.write(crashFile, '{"k":"after-crash"}'))), '备份后改名前出错时写入报错')
  ok((await readFile(crashFile, 'utf8')) === '{"k":"before-crash"}', '备份后改名前出错时原文件不变')
  const crashBackups = (await readdir(dir)).filter((name) => name.startsWith('crash.json.plaintext-'))
  ok(crashBackups.length === 1 && (await readFile(join(dir, crashBackups[0]), 'utf8')) === '{"k":"before-crash"}', '备份已完整留下')
  await crash.vault.write(crashFile, '{"k":"after-crash"}')
  ok((await crash.vault.read(crashFile)) === '{"k":"after-crash"}' && (await readFile(crashFile, 'utf8')).startsWith('inkstone-sealed:v1:'), '再次写入正常完成加密')

  const readOnly = join(dir, 'read-only.json')
  await writeFile(readOnly, '{"k":"ro"}')
  await chmod(readOnly, 0o444)
  if (process.platform === 'win32') {
    const probe = join(dir, 'probe.tmp')
    await writeFile(probe, 'x')
    const code = (await errorOf(() => rename(probe, readOnly)))?.code
    ok(code === 'EPERM', 'Windows 上改名覆盖只读文件会报 EPERM（atomic-write 走回退分支的前提）', String(code))
    await rm(probe, { force: true })
  }
  await vault.write(readOnly, '{"k":"ro-2"}')
  ok((await vault.read(readOnly)) === '{"k":"ro-2"}' && (await readFile(readOnly, 'utf8')).startsWith('inkstone-sealed:v1:'), '目标只读时 atomic-write 经回退分支仍能写入密文', `${await readFile(readOnly, 'utf8')} | ${(await readdir(dir)).filter((name) => name.startsWith('read-only')).join(',')} | ${lines.slice(-4).join(' / ')}`)

  const race = join(dir, 'race.json')
  await writeFile(race, '{"v":0}')
  await Promise.all([vault.sweep([race]), vault.write(race, '{"v":1}'), vault.write(race, '{"v":2}')])
  const raceBackups = (await readdir(dir)).filter((name) => name.startsWith('race.json.plaintext-'))
  ok((await vault.read(race)) === '{"v":2}' && raceBackups.length === 1 && (await readFile(join(dir, raceBackups[0]), 'utf8')) === '{"v":0}', '启动迁移与并发写入排队执行：最后一次写入生效，只备份一次原明文')
  const race2 = join(dir, 'race2.json')
  await writeFile(race2, '{"v":0}')
  await Promise.all([vault.write(race2, '{"v":1}'), vault.sweep([race2]), vault.write(race2, '{"v":3}')])
  ok((await vault.read(race2)) === '{"v":3}' && (await readdir(dir)).filter((name) => name.startsWith('race2.json.plaintext-')).length === 1, '写入先于迁移时迁移不重复备份、不覆盖新内容')

  ok(v.credentialFilesIn(dir).map((path) => path.slice(dir.length + 1)).sort().join(',') === 'api-keys.json,codex-accounts.json,image-config.json,oauth-accounts.json,relay-bridge.json,search-config.json', '启动迁移覆盖的凭据文件清单')
  ok(v.plaintextCredentialsRequested({ YAN_PLAINTEXT_CREDENTIALS: '1' }, [], false) && !v.plaintextCredentialsRequested({}, [], false) && !v.plaintextCredentialsRequested({ YAN_PLAINTEXT_CREDENTIALS: '0' }, [], false), 'YAN_PLAINTEXT_CREDENTIALS=1 打开明文模式')
  ok(v.plaintextCredentialsRequested({}, ['electron', '.', '--yan-plaintext-credentials'], false) && v.plaintextCredentialsRequested({}, ['--yan-plaintext-credentials=1'], false) && !v.plaintextCredentialsRequested({}, ['--yan-plaintext-credentials=0'], false), '命令行参数 --yan-plaintext-credentials 同样打开明文模式')
  ok(v.plaintextCredentialsRequested({}, [], true), '便携版默认不加密')
}

async function retentionTests(ok, compile, root) {
  const dir = join(root, 'retention')
  await mkdir(dir, { recursive: true })
  const v = await compile(null, {
    stdin: { contents: "export * from './src/main/credential-vault'", resolveDir: process.cwd(), loader: 'ts' },
    plugins: [electronStub]
  })
  const fake = fakeSafeStorage()
  const lines = []
  let clock = Date.now()
  let plaintext = false
  let currentKey = 'aaaaaaaaaaaaaaaa'
  const vault = v.createCredentialVault({
    cipher: v.safeStorageCipher(async () => fake.safeStorage, async () => currentKey),
    plaintext: () => plaintext,
    log: (file, line) => lines.push(line),
    now: () => clock
  })
  const file = join(dir, 'api-keys.json')
  const stateFile = join(dir, 'credential-vault-state.json')
  const backups = async () => (await readdir(dir)).filter((name) => name.startsWith('api-keys.json.plaintext-'))
  const okStarts = async () => JSON.parse(await readFile(stateFile, 'utf8')).files['api-keys.json'].okStarts
  await writeFile(file, '{"key":"sk-retention-SECRET"}')
  await vault.sweep([file])
  ok((await backups()).length === 1 && (await okStarts()) === 0, '迁移那次启动不算成功解密')
  ok(v.backupCreatedAt(join(dir, (await backups())[0]), 0) > Date.now() - 60_000, '从备份文件名取出创建时间')

  clock = Date.now() + 8 * DAY
  for (let i = 0; i < 4; i++) await vault.sweep([file])
  ok((await okStarts()) === 4 && (await backups()).length === 1, '连续 4 次成功解密不删备份')
  fake.state.failDecrypt = true
  await errorOf(() => vault.read(file))
  fake.state.failDecrypt = false
  ok((await okStarts()) === 0 && lines.some((line) => line.startsWith('stable-reset')), '任何一次解密失败计数清零并记日志')
  for (let i = 0; i < 4; i++) await vault.sweep([file])
  ok((await okStarts()) === 4 && (await backups()).length === 1, '清零后重新从头计数')
  currentKey = undefined
  const noLocalState = await errorOf(() => vault.read(file))
  currentKey = 'aaaaaaaaaaaaaaaa'
  ok(noLocalState instanceof v.CredentialVaultError && noLocalState.message.includes('系统加密') && !noLocalState.message.includes('密钥已变化'), '读不到 Local State 时按「系统加密暂不可用」报错，不说成密钥变化', noLocalState?.message)
  ok((await okStarts()) === 4, '读不到 Local State 不清零计数')
  clock = Date.now() + 6 * DAY
  await vault.sweep([file])
  ok((await okStarts()) === 5 && (await backups()).length === 1, '连续 5 次成功但备份未满 7 天不删')
  clock = Date.now() + 8 * DAY
  await vault.sweep([file])
  ok((await backups()).length === 0, '连续 5 次以上成功且备份满 7 天后自动删除')
  ok(lines.some((line) => line.startsWith('backup-deleted') && line.includes('successful starts')), '自动删除写进日志')
  const stateText = await readFile(stateFile, 'utf8')
  ok(!stateText.includes('sk-retention-SECRET') && Object.keys(JSON.parse(stateText).files['api-keys.json']).sort().join(',') === 'okStarts,updatedAt', '状态文件只有计数和时间，不含密钥')

  plaintext = true
  await vault.sweep([file])
  ok((await okStarts()) === 0, '回退到明文后计数清零')
  plaintext = false
  await vault.sweep([file])
  ok((await backups()).length === 1, '回退后再加密产生新的明文备份')
  clock = Date.now() + 8 * DAY
  for (let i = 0; i < 4; i++) await vault.sweep([file])
  ok((await backups()).length === 1, '新备份同样要等连续 5 次成功')
  await vault.sweep([file])
  ok((await backups()).length === 0, '新备份满足条件后同样自动删除')

  await writeFile(file, '{"key":"sk-manual"}')
  await vault.sweep([file])
  const other = join(dir, 'oauth-accounts.json')
  await writeFile(other, '{"version":1,"providers":{}}')
  await vault.sweep([other])
  const listed = await vault.backups([file, other])
  ok(listed.length === 2, '手动删除前列出全部明文备份')
  const trashed = []
  const result = await vault.removeBackups([file, other], async (path) => {
    trashed.push(path)
    await rm(path)
  })
  ok(result.removed.length === 2 && result.failed.length === 0 && trashed.join() === listed.join(), '手动删除逐个交给删除函数（应用里是移到回收站）')
  ok((await vault.backups([file, other])).length === 0 && (await vault.read(file)) === '{"key":"sk-manual"}', '手动删除只删备份，加密文件照常可读')
  ok(lines.filter((line) => line.includes('removed by the user')).length === 2, '手动删除写进日志')
  await writeFile(file, '{"key":"sk-manual"}')
  await vault.sweep([file])
  fake.state.failDecrypt = true
  const kept = await vault.removeBackups([file], async (path) => rm(path))
  fake.state.failDecrypt = false
  ok(kept.skipped.length === 1 && kept.removed.length === 0 && (await vault.backups([file])).length === 1 && lines.some((line) => line.startsWith('backup-kept')), '手动删除跳过此刻解不开的文件对应的备份，并返回跳过份数')
  const failed = await vault.removeBackups([file], async () => { throw new Error('in use') })
  ok(failed.failed.length === 1 && (await vault.backups([file])).length === 1 && lines.some((line) => line.startsWith('backup-delete-failed')), '删除失败的备份保留并记日志')
}

await runSuite(import.meta.url, async (ok, compile) => {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-credential-vault-'))
  await storeTests(ok, compile, root)
  await vaultTests(ok, compile, root)
  await retentionTests(ok, compile, root)
}, { isolate: true })
