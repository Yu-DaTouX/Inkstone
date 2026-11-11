import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import commandcodeExtension from '../resources/pi-extensions/commandcode.js'

const previous = { dir: process.env.PI_CODING_AGENT_DIR, key: process.env.COMMANDCODE_API_KEY, fetch: globalThis.fetch }
const root = await mkdtemp(join(tmpdir(), 'yan-commandcode-ext-'))

function fakePi() {
  const registered = []
  return { registered, registerProvider: (name, config) => registered.push({ name, config }) }
}

async function until(condition, label, limitMs = 3000) {
  const started = Date.now()
  while (!condition()) {
    assert.ok(Date.now() - started < limitMs, label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

try {
  process.env.PI_CODING_AGENT_DIR = root
  process.env.COMMANDCODE_API_KEY = 'synthetic-key'

  {
    globalThis.fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return { ok: true, json: async () => ({ data: [{ id: 'vendor/model-a', name: 'Model A' }] }) }
    }
    const pi = fakePi()
    await commandcodeExtension(pi)
    assert.equal(pi.registered.length, 1, '无缓存时工厂等待 refresh 完成，返回前已注册')
    assert.equal(pi.registered[0].name, 'commandcode')
    assert.deepEqual(pi.registered[0].config.models.map((m) => m.id), ['vendor/model-a'])
    const cachePath = join(root, 'yan-commandcode-models.json')
    assert.ok(existsSync(cachePath), '成功后写缓存')
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).models[0].id, 'vendor/model-a')
  }

  {
    let release
    globalThis.fetch = () => new Promise((resolve) => { release = resolve })
    const pi = fakePi()
    commandcodeExtension(pi)
    assert.equal(pi.registered.length, 1, '有缓存时同步先注册缓存列表')
    assert.deepEqual(pi.registered[0].config.models.map((m) => m.id), ['vendor/model-a'])
    release({ ok: true, json: async () => ({ data: [{ id: 'vendor/model-b' }] }) })
    await until(() => pi.registered.length === 2, '缓存之后后台刷新再更新 provider')
    assert.deepEqual(pi.registered[1].config.models.map((m) => m.id), ['vendor/model-b'])
  }

  {
    globalThis.fetch = async () => { throw new Error('offline') }
    await writeFile(join(root, 'yan-commandcode-models.json'), 'not json')
    const pi = fakePi()
    await commandcodeExtension(pi)
    assert.equal(pi.registered.length, 0, '缓存损坏且离线时不抛错也不注册')
  }
} finally {
  globalThis.fetch = previous.fetch
  if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previous.dir
  if (previous.key === undefined) delete process.env.COMMANDCODE_API_KEY
  else process.env.COMMANDCODE_API_KEY = previous.key
  await rm(root, { recursive: true, force: true })
}

console.log('commandcode-extension: ok')
