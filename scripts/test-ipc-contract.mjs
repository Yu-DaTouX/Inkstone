import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const knownDrift = {
  preloadOnly: {},
  mainOnly: {}
}

const read = (path) => readFileSync(path, 'utf8')

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(path)
  }
  return files
}

function channelConstants() {
  const constants = new Map()
  for (const path of sourceFiles('src/shared')) {
    const text = read(path)
    for (const match of text.matchAll(/export const ([A-Z][A-Z0-9_]*) = '(yan[^']*)'/g)) constants.set(match[1], match[2])
    for (const table of text.matchAll(/export const ([A-Z][A-Z0-9_]*_CHANNELS) = \{([\s\S]*?)\n\} as const/g)) {
      for (const entry of table[2].matchAll(/(\w+):\s*'([^']+)'/g)) constants.set(`${table[1]}.${entry[1]}`, entry[2])
    }
  }
  return constants
}

function resolveChannel(expression, constants) {
  const literal = expression.match(/^'([^']+)'$/)
  if (literal) return literal[1]
  return constants.get(expression)
}

function collect(text, pattern, constants, unresolved, file) {
  const found = new Map()
  for (const match of text.matchAll(pattern)) {
    const expression = match[1]
    const channel = resolveChannel(expression, constants)
    if (!channel) unresolved.push(`${file}: ${expression}`)
    else if (!found.has(channel)) found.set(channel, file)
  }
  return found
}

const ARG = `\\s*('[^']+'|[A-Z][A-Z0-9_]*(?:\\.\\w+)?)\\s*[,)]`

function withoutGenerics(text) {
  let output = ''
  for (let index = 0; index < text.length; index++) {
    const before = text.slice(Math.max(0, index - 6), index)
    if (text[index] === '<' && /(?<![\w.])invoke$/.test(before)) {
      let depth = 0
      for (; index < text.length; index++) {
        if (text[index] === '<') depth++
        else if (text[index] === '>' && text[index - 1] !== '=' && --depth === 0) break
      }
      continue
    }
    output += text[index]
  }
  return output
}

function scan() {
  const constants = channelConstants()
  const unresolved = []
  const preloadText = read('src/preload/index.ts')
  const preloadSent = new Map()
  const flattened = withoutGenerics(preloadText)
  const preloadTyped = collect(flattened, new RegExp(`(?<![\\w.])invoke\\(${ARG}`, 'g'), constants, unresolved, 'src/preload/index.ts')
  const preloadUnmapped = collect(flattened, new RegExp(`(?<![\\w.])invokeUnmapped\\(${ARG}`, 'g'), constants, unresolved, 'src/preload/index.ts')
  for (const [channel, file] of [...preloadTyped, ...preloadUnmapped]) preloadSent.set(channel, file)
  for (const [channel, file] of collect(flattened, new RegExp(`ipcRenderer\\.(?:invoke|send)\\(${ARG}`, 'g'), constants, unresolved, 'src/preload/index.ts')) preloadSent.set(channel, file)
  const mainRegistered = new Map()
  const registrarRegistered = new Map()
  const viaRegistrar = new RegExp(`(?:(?<![\\w.])|\\b(?:ipc|registrar)\\.)(?:handle|rawHandle)\\(${ARG}`, 'g')
  const templated = /(?:(?<![\w.])|\b(?:ipc|registrar)\.)(?:handle|rawHandle)\(`(yan:[^`$]*)\$\{(\w+)\}([^`]*)`/g
  const registration = new RegExp(`(?:(?<![\\w.])(?:handle|rawHandle)|\\b(?:ipc|ipcMain|registrar)\\.(?:handle|rawHandle|on|once))\\(${ARG}`, 'g')
  for (const path of sourceFiles('src/main')) {
    const text = read(path)
    for (const [channel, file] of collect(text, registration, constants, unresolved, path)) if (!mainRegistered.has(channel)) mainRegistered.set(channel, file)
    for (const [channel, file] of collect(text, viaRegistrar, constants, [], path)) if (!registrarRegistered.has(channel)) registrarRegistered.set(channel, file)
    for (const match of text.matchAll(templated)) {
      const loop = text.match(new RegExp(`for \\(const ${match[2]} of \\[([^\\]]*)\\]`))
      const values = [...(loop?.[1] ?? '').matchAll(/'([^']+)'/g)].map((value) => value[1])
      if (!values.length) unresolved.push(`${path}: \`${match[1]}\${${match[2]}}${match[3]}\``)
      for (const value of values) {
        if (!mainRegistered.has(`${match[1]}${value}${match[3]}`)) mainRegistered.set(`${match[1]}${value}${match[3]}`, path)
        if (!registrarRegistered.has(`${match[1]}${value}${match[3]}`)) registrarRegistered.set(`${match[1]}${value}${match[3]}`, path)
      }
    }
  }
  return { constants, unresolved, preloadText, preloadSent, preloadTyped, preloadUnmapped, mainRegistered, registrarRegistered }
}

function channelMapKeys() {
  const text = read('src/shared/ipc-channels.ts')
  const body = text.match(/export interface IpcChannelMap \{\n([\s\S]*?)\n\}/)?.[1] ?? ''
  return new Set([...body.matchAll(/^  '([^']+)':/gm)].map((match) => match[1]))
}

const difference = (left, right) => [...left].filter((value) => !right.has(value)).sort()

await runSuite(import.meta.url, async (ok) => {
  const { unresolved, preloadText, preloadSent, preloadTyped, preloadUnmapped, mainRegistered, registrarRegistered } = scan()
  ok(preloadSent.size > 200 && mainRegistered.size > 200, '扫描到足够多的通道，抽取规则没有失效', `preload ${preloadSent.size} / main ${mainRegistered.size}`)
  ok(unresolved.length === 0, '所有通道名都能静态解析（字面量或 shared 里的常量表）', unresolved.join('; '))
  ok(preloadSent.has('yan:mcpAppView:prepare') && mainRegistered.has('yan:mcpAppView:prepare'), '常量表通道（MCP_APP_VIEW_CHANNELS）两端都被识别')
  ok(preloadSent.has('win:minimize') && mainRegistered.has('win:minimize'), 'send / ipcMain.on 通道被识别')

  const preloadOnly = [...preloadSent.keys()].filter((channel) => !mainRegistered.has(channel)).sort()
  const mainOnly = [...mainRegistered.keys()].filter((channel) => !preloadSent.has(channel)).sort()
  const newPreloadOnly = preloadOnly.filter((channel) => !Object.hasOwn(knownDrift.preloadOnly, channel))
  const newMainOnly = mainOnly.filter((channel) => !Object.hasOwn(knownDrift.mainOnly, channel))
  ok(newPreloadOnly.length === 0, 'preload 发出的通道在主进程都有注册（已知例外除外）', newPreloadOnly.join(', '))
  ok(newMainOnly.length === 0, '主进程注册的通道 preload 都有调用（已知例外除外）', newMainOnly.join(', '))
  const stalePreloadOnly = Object.keys(knownDrift.preloadOnly).filter((channel) => !preloadOnly.includes(channel))
  const staleMainOnly = Object.keys(knownDrift.mainOnly).filter((channel) => !mainOnly.includes(channel))
  ok(stalePreloadOnly.length + staleMainOnly.length === 0, '已知例外表里没有已经消除的条目，修好后请删掉', [...stalePreloadOnly, ...staleMainOnly].join(', '))
  ok(Object.values({ ...knownDrift.preloadOnly, ...knownDrift.mainOnly }).every((reason) => typeof reason === 'string' && reason.length > 0), '每条已知例外都写明原因')

  const mapped = channelMapKeys()
  const typedSet = new Set(preloadTyped.keys())
  const registrarSet = new Set(registrarRegistered.keys())
  ok(mapped.size > 300, '类型映射里读到足够多的通道，抽取规则没有失效', `map ${mapped.size}`)
  ok(difference(mapped, typedSet).length + difference(typedSet, mapped).length === 0, '映射里的通道集合 = preload 经类型化 invoke 发出的通道集合', [...difference(mapped, typedSet).map((c) => `仅映射 ${c}`), ...difference(typedSet, mapped).map((c) => `仅 preload ${c}`)].join(', '))
  ok(difference(mapped, registrarSet).length + difference(registrarSet, mapped).length === 0, '映射里的通道集合 = 主进程经 handle / rawHandle 注册的通道集合', [...difference(mapped, registrarSet).map((c) => `仅映射 ${c}`), ...difference(registrarSet, mapped).map((c) => `仅主进程 ${c}`)].join(', '))
  const unmappedInMap = [...preloadUnmapped.keys()].filter((channel) => mapped.has(channel))
  ok(unmappedInMap.length === 0, 'invokeUnmapped 只用于映射外的通道', unmappedInMap.join(', '))
  ok(!/(?<![\w.])invoke</.test(preloadText), 'preload 的 invoke 不再手写返回类型参数')

})
