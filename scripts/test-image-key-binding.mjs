import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-image-key-binding-'))
const originalEnv = { ...process.env }
let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks++
}

const built = await build({
  stdin: {
    contents: "export * from './src/main/image-config.ts'; export * from './src/main/image-credentials.ts';",
    resolveDir: process.cwd(),
    sourcefile: 'image-key-binding-fixture.ts'
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})

try {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('YAN_IMAGE_') || ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'ARK_API_KEY', 'CODEX_HOME'].includes(name)) delete process.env[name]
  }
  process.env.YAN_DATA_DIR = root
  process.env.YAN_PI_DIR = join(root, 'pi')
  const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const { updateImageConfig, setImageKey, clearImageKey, imageFileKey, normalizeImageEndpoint, refreshImageConfig, hostImageCredentials } = mod
  const configFile = join(root, 'image-config.json')
  const keyInFile = async (service) => {
    const raw = JSON.parse(await readFile(configFile, 'utf8'))
    return raw.keys?.[service]
  }

  ok(normalizeImageEndpoint('https://Relay.Example:443/v1/') === 'https://relay.example/v1', '地址比较规范化协议、主机与末尾斜杠')
  ok(normalizeImageEndpoint(' https://a.example/v1// ') === 'https://a.example/v1', '地址比较忽略首尾空白与重复斜杠')

  ok((await updateImageConfig({ baseUrl: 'https://a.example/v1' })).ok, '设置兼容接口地址')
  ok((await setImageKey('compatible', 'sk-for-a')).ok, '保存兼容 Key')
  await refreshImageConfig()
  ok((await hostImageCredentials.secret('compatible')) === 'sk-for-a', '地址未变时保存的 Key 可用')

  ok((await updateImageConfig({ baseUrl: 'https://b.example/v1' })).ok, '把兼容接口改到新地址')
  await refreshImageConfig()
  ok(imageFileKey('compatible') === undefined, '地址变化后旧 Key 不再作为兼容 Key 返回')
  ok((await hostImageCredentials.secret('compatible')) === undefined, '改地址后不再向调用方提供旧 Key')
  ok((await keyInFile('compatible')) === undefined, '改地址后配置文件里不再保留兼容 Key')

  ok((await setImageKey('compatible', 'sk-for-b')).ok, '给新地址重新保存 Key')
  await refreshImageConfig()
  ok((await hostImageCredentials.secret('compatible')) === 'sk-for-b', '新地址重新绑定后的 Key 可用')
  ok(JSON.parse(await readFile(configFile, 'utf8')).keyEndpoints.compatible === 'https://b.example/v1', '保存 Key 时记录其绑定的接口地址')
  ok((await updateImageConfig({ baseUrl: 'https://B.example/v1/' })).ok, '只改写法（大小写与末尾斜杠）不算换地址')
  await refreshImageConfig()
  ok((await hostImageCredentials.secret('compatible')) === 'sk-for-b', '规范化后相同的地址保留 Key')

  ok((await clearImageKey('compatible')).ok, '清除兼容 Key')
  ok(JSON.parse(await readFile(configFile, 'utf8')).keyEndpoints?.compatible === undefined, '清除 Key 时一并清除绑定记录')

  process.env.YAN_IMAGE_API_BASE = 'https://env.example/v1'
  process.env.YAN_IMAGE_API_KEY = 'env-key'
  ok((await updateImageConfig({ baseUrl: '' })).ok, '清空设置里的地址')
  await refreshImageConfig()
  ok((await hostImageCredentials.secret('compatible')) === 'env-key', '环境变量地址与环境变量 Key 一致时可用')

  ok((await updateImageConfig({ baseUrl: 'https://other.example/v1' })).ok, '设置里改用与环境变量不同的地址')
  await refreshImageConfig()
  ok((await hostImageCredentials.secret('compatible')) === undefined, '环境变量 Key 不跟随设置里的不同地址')

  ok((await updateImageConfig({ baseUrl: 'https://env.example/v1/' })).ok, '设置回环境变量声明的地址')
  await refreshImageConfig()
  ok((await hostImageCredentials.secret('compatible')) === 'env-key', '地址与声明一致时环境变量 Key 恢复可用')

  delete process.env.YAN_IMAGE_API_BASE
  await refreshImageConfig()
  ok((await updateImageConfig({ baseUrl: '' })).ok, '设置里不再保存地址')
  process.env.YAN_IMAGE_API_BASE = 'https://env.example/v1'
  await refreshImageConfig()
  ok((await setImageKey('compatible', 'sk-env-bound')).ok, '没有设置地址时给环境变量地址保存 Key')
  ok(JSON.parse(await readFile(configFile, 'utf8')).keyEndpoints.compatible === 'https://env.example/v1', '绑定记录指向当时生效的环境变量地址')
  process.env.YAN_IMAGE_API_BASE = 'https://moved.example/v1'
  await refreshImageConfig()
  ok(imageFileKey('compatible') === undefined, '环境变量地址在之后变化时，已绑定的 Key 不再使用')
  ok((await hostImageCredentials.secret('compatible')) === 'env-key', '环境变量自身的 Key 仍按其声明的地址生效，但不使用漂移前保存的 Key')
  delete process.env.YAN_IMAGE_API_KEY
  ok((await hostImageCredentials.secret('compatible')) === undefined, '没有环境变量 Key 时也不提供漂移前保存的 Key')

  ok((await updateImageConfig({ baseUrl: 'https://settings.example/v1' })).ok, '把地址改回设置里配置')
  delete process.env.YAN_IMAGE_API_BASE
  process.env.YAN_IMAGE_API_KEY = 'lonely-env-key'
  await refreshImageConfig()
  ok((await hostImageCredentials.secret('compatible')) === undefined, '只有环境变量 Key、没有声明地址时不会拿它向设置里的地址发送')
  ok((await updateImageConfig({ baseUrl: 'https://settings-two.example/v1' })).ok, '把设置里的地址从 A 改到 B')
  await refreshImageConfig()
  ok((await hostImageCredentials.secret('compatible')) === undefined, '地址变化后仍不允许没有声明地址的环境变量 Key 跟随')

  ok(normalizeImageEndpoint('https://a.example/v1?x=1') !== normalizeImageEndpoint('https://a.example/v1'), '查询参数不同的地址不会被归为同一个')
  ok(!(await updateImageConfig({ baseUrl: 'https://a.example/v1?x=1' })).ok, '带查询参数的接口地址被明确拒绝')
  ok(!(await updateImageConfig({ baseUrl: 'https://user:pass@a.example/v1' })).ok, '带账号密码的接口地址被明确拒绝')
  ok(!(await updateImageConfig({ baseUrl: 'https://a.example/v1#frag' })).ok, '带 # 片段的接口地址被明确拒绝')
  await refreshImageConfig()
  ok(JSON.parse(await readFile(configFile, 'utf8')).baseUrl === 'https://settings-two.example/v1', '被拒绝的地址不会写进配置')

  console.log(`image-key-binding: ${checks} checks passed (synthetic config only, no network)`)
} finally {
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
  Object.assign(process.env, originalEnv)
  await rm(root, { recursive: true, force: true })
}
