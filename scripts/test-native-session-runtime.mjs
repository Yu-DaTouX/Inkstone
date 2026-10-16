/*
 * 原生会话桥的定向单测（不启动 pi、不联网、不碰真实用户目录）。
 *
 * 覆盖两层：
 *   · 扩展资源 `resources/pi-extensions/native-session-bridge.js` 的纯函数与命令处理器
 *     —— trust.json / settings.json 的官方格式读写、信封编解码、navigate/reload 回执；
 *   · 宿主模块 `src/main/native-session-runtime.ts`（用 esbuild 就地打包）—— 请求编码、
 *     回执拦截、id 匹配、超时/未就绪/未被识别三种失败，以及不可变老的 ctx 回执路径。
 *
 * 用法：node scripts/test-native-session-runtime.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let passed = 0
let failed = 0
function ok(condition, label) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}

/** 动态导入扩展资源（纯 node builtins，可直接 import）。 */
async function loadExtension() {
  const url = pathToFileURL(join(process.cwd(), 'resources', 'pi-extensions', 'native-session-bridge.js')).href
  return import(`${url}?t=${Date.now()}`)
}

/** 用 esbuild 把宿主 TS 模块打包成一个临时 ESM 再导入。 */
async function loadRuntime() {
  const { build } = await import('esbuild')
  const outfile = join('out', 'test', 'native-session-runtime.mjs')
  await build({
    entryPoints: ['src/main/native-session-runtime.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  return import(pathToFileURL(join(process.cwd(), outfile)).href)
}

async function testTrust(ext, dir) {
  console.log('trust.json（官方格式）')
  const file = join(dir, 'trust.json')
  await writeFile(file, JSON.stringify({ 'E:\\a': true, 'E:\\a\\b': false }, null, 2), 'utf8')

  const table = ext.readTrustTable(file)
  ok(table['E:\\a'] === true && table['E:\\a\\b'] === false, '读取并校验 true/false/null')

  await writeFile(file, JSON.stringify({ x: 'yes' }), 'utf8')
  let rejected = false
  try {
    ext.readTrustTable(file)
  } catch {
    rejected = true
  }
  ok(rejected, '非法值被拒绝，不静默吞掉')

  /* 向上查找：精确命中优先，否则沿父目录 */
  const walked = ext.findNearestTrustEntry({ 'C:\\repo': true, 'C:\\repo\\sub': false }, 'C:\\repo\\sub\\deep')
  ok(walked?.path === 'C:\\repo\\sub' && walked.decision === false, '子目录显式 false 阻断父目录 true')

  await writeFile(file, JSON.stringify({ 'C:\\keep': true }, null, 2), 'utf8')
  const saved = ext.saveTrustDecision(file, dir, true)
  const raw = await readFile(file, 'utf8')
  const parsed = JSON.parse(raw)
  ok(parsed['C:\\keep'] === true, '保存时保留其它条目')
  ok(raw.endsWith('\n'), '写入带末尾换行（与 pi 的 writeTrustFile 一致）')
  ok(parsed[saved.entry] === true, '写入目标目录条目')

  ext.saveTrustDecision(file, dir, null)
  const after = JSON.parse(await readFile(file, 'utf8'))
  ok(!(saved.entry in after), 'decision=null 删除条目')
}

async function testSettings(ext, dir) {
  console.log('settings.json 的 enabledModels（官方格式）')
  const file = join(dir, 'settings.json')
  await writeFile(file, JSON.stringify({ theme: 'dark', compaction: { enabled: true } }, null, 2), 'utf8')
  ext.writeEnabledModels(file, ['anthropic/claude', 'openai/gpt'])
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  ok(Array.isArray(parsed.enabledModels) && parsed.enabledModels.length === 2, '写入 enabledModels')
  ok(parsed.theme === 'dark' && parsed.compaction?.enabled === true, '保留其它设置字段')
  ok(ext.readEnabledModels(file).length === 2, '回读 enabledModels')

  ext.writeEnabledModels(file, [])
  const cleared = JSON.parse(await readFile(file, 'utf8'))
  ok(!('enabledModels' in cleared), '空数组清除字段（回到「不 scoped」）')
}

async function testEnvelopeAndReceipt(ext, runtime) {
  console.log('请求信封与回执编解码（宿主 / 扩展两侧互认）')
  const encoded = runtime.encodeEnvelope('req-1', 'navigate_tree', { targetId: 'abc' })
  const decoded = ext.parseEnvelope(encoded)
  ok(decoded.id === 'req-1' && decoded.op === 'navigate_tree' && decoded.args.targetId === 'abc', '宿主编码 → 扩展解码')

  let badHost = false
  try {
    ext.parseEnvelope(Buffer.from(JSON.stringify({ v: 1, host: 'other', id: 'x', op: 'y' })).toString('base64url'))
  } catch {
    badHost = true
  }
  ok(badHost, '拒绝非砚宿主的调用方')

  let badVersion = false
  try {
    ext.parseEnvelope(Buffer.from(JSON.stringify({ v: 99, host: 'inkstone', id: 'x', op: 'y' })).toString('base64url'))
  } catch {
    badVersion = true
  }
  ok(badVersion, '拒绝不支持的版本')

  const text = ext.buildReceipt({ id: 'req-9', op: 'trust_read', ok: true, result: { decision: true } })
  const parsed = runtime.parseReceipt(text)
  ok(parsed?.id === 'req-9' && parsed.ok === true && parsed.result.decision === true, '扩展编码 → 宿主解码')
  ok(runtime.parseReceipt('ordinary notification') === null, '普通通知不误判为回执')
}

/** 造一个受控的扩展 ctx / pi，跑命令处理器并收集 notify 回执。 */
function makeFakeHost(ext, { settings = {}, cwd = process.cwd(), onNavigate, onReload } = {}) {
  const receipts = []
  const state = { stale: false, idle: true }
  const pi = {
    handlers: {},
    commands: {},
    on(event, handler) {
      ;(this.handlers[event] ??= []).push(handler)
    },
    registerCommand(name, options) {
      this.commands[name] = options
    },
    getSettings: () => settings
  }
  const ctx = {
    cwd,
    get ui() {
      return {
        notify(message) {
          receipts.push(message)
        }
      }
    },
    isIdle: () => {
      if (state.stale) throw new Error('stale ctx')
      return state.idle
    },
    navigateTree: async (targetId, options) => {
      if (state.stale) throw new Error('stale ctx')
      return onNavigate ? onNavigate(targetId, options) : { cancelled: false }
    },
    reload: async () => {
      state.stale = true
      if (onReload) await onReload()
    },
    sessionManager: {
      getLeafId: () => (state.stale ? (() => { throw new Error('stale ctx') })() : 'leaf-42'),
      getBranch: () => ['root', 'mid', 'leaf-42'].map((id) => ({ id })),
      getSessionFile: () => '/tmp/session.jsonl'
    }
  }
  ext.default(pi)
  return { pi, ctx, receipts, state }
}

/** 从回执文本里取出 JSON。 */
function receiptOf(text, runtime) {
  return runtime.parseReceipt(text)
}

async function testExtensionHandlers(ext, runtime) {
  console.log('扩展命令处理器')

  /* The bridge must be explicitly enabled by the desktop host. */
  delete process.env.YAN_NATIVE_BRIDGE
  const disabled = makeFakeHost(ext)
  ok(Object.keys(disabled.pi.commands).length === 0, '未开启宿主开关时不注册命令')
  process.env.YAN_NATIVE_BRIDGE = '1'
  const loaded = makeFakeHost(ext)
  ok(!!loaded.pi.commands[ext.NATIVE_COMMAND], '加载后注册宿主专用命令')
  ok(typeof loaded.pi.registerTool === 'undefined', '未注册任何模型工具')
  const off = loaded
  ok(Object.keys(off.pi.commands).length === 1, '命令表只有这一个宿主专用命令')

  /* navigate_tree：固定 summarize:false，并回实际 branch */
  let seenOptions
  const nav = makeFakeHost(ext, {
    onNavigate: (targetId, options) => {
      seenOptions = options
      return { cancelled: false }
    }
  })
  const navCmd = nav.pi.commands[ext.NATIVE_COMMAND]
  ok(!!navCmd, '注册了宿主专用命令')
  await navCmd.handler(
    runtime.encodeEnvelope('nav-1', 'navigate_tree', { targetId: 'mid' }),
    nav.ctx
  )
  const navReceipt = receiptOf(nav.receipts.at(-1), runtime)
  ok(navReceipt?.id === 'nav-1' && navReceipt.ok === true, '导航回执 id/ok 正确')
  ok(seenOptions?.summarize === false, '导航固定 summarize:false（不触发模型摘要）')
  ok(
    navReceipt.result.leafId === 'leaf-42' && navReceipt.result.branchIds.join(',') === 'root,mid,leaf-42',
    '导航回执带实际叶子与当前 branch'
  )

  /* reload：await 后旧 ctx 已 stale，仍能用捕获的 ui 发完成回执 */
  const rel = makeFakeHost(ext)
  await rel.pi.commands[ext.NATIVE_COMMAND].handler(
    runtime.encodeEnvelope('rel-1', 'reload', {}),
    rel.ctx
  )
  const relReceipt = receiptOf(rel.receipts.at(-1), runtime)
  ok(relReceipt?.id === 'rel-1' && relReceipt.ok === true && relReceipt.result?.phase === 'completed', 'reload 用捕获的 ui 发完成回执（不碰 stale ctx）')

  /* busy：不空闲时拒绝，且不执行操作 */
  let navigated = false
  const busy = makeFakeHost(ext, {
    onNavigate: () => {
      navigated = true
      return { cancelled: false }
    }
  })
  busy.state.idle = false
  await busy.pi.commands[ext.NATIVE_COMMAND].handler(
    runtime.encodeEnvelope('busy-1', 'navigate_tree', { targetId: 'mid' }),
    busy.ctx
  )
  const busyReceipt = receiptOf(busy.receipts.at(-1), runtime)
  ok(busyReceipt?.ok === false && busyReceipt.error?.code === 'busy' && !navigated, '会话不空闲时拒绝且不执行')

  /* scoped_models_read：运行时 scoped + 设置里的原始 pattern */
  const scoped = makeFakeHost(ext, { settings: { enabledModels: ['a/b'] } })
  const scopedCtx = Object.assign(Object.create(Object.getPrototypeOf(scoped.ctx)), scoped.ctx, {
    scopedModels: [{ model: { provider: 'a', id: 'b', name: 'B' }, thinkingLevel: 'high' }]
  })
  await scoped.pi.commands[ext.NATIVE_COMMAND].handler(
    runtime.encodeEnvelope('sc-1', 'scoped_models_read', {}),
    scopedCtx
  )
  const scopedReceipt = receiptOf(scoped.receipts.at(-1), runtime)
  ok(scopedReceipt?.result.scoped[0]?.id === 'b' && scopedReceipt.result.scoped[0]?.thinkingLevel === 'high', '读取运行时 scoped models')
  ok(scopedReceipt.result.enabledModels?.[0] === 'a/b', '读取设置里的原始 pattern')

  /* trust_read / trust_save：真实落盘到隔离目录 */
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-native-test-'))
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    await writeFile(join(dir, 'trust.json'), JSON.stringify({ [dir]: true }, null, 2), 'utf8')
    const trustHost = makeFakeHost(ext, { cwd: dir })
    await trustHost.pi.commands[ext.NATIVE_COMMAND].handler(
      runtime.encodeEnvelope('tr-1', 'trust_read', {}),
      trustHost.ctx
    )
    const readReceipt = receiptOf(trustHost.receipts.at(-1), runtime)
    ok(readReceipt?.result.decision === true && readReceipt.result.entry === dir, 'trust_read 不带 cwd 时用 pi 自己的 ctx.cwd 命中 true')

    await trustHost.pi.commands[ext.NATIVE_COMMAND].handler(
      runtime.encodeEnvelope('tr-2', 'trust_save', { cwd: dir, decision: false }),
      trustHost.ctx
    )
    const saveReceipt = receiptOf(trustHost.receipts.at(-1), runtime)
    const savedTable = JSON.parse(await readFile(join(dir, 'trust.json'), 'utf8'))
    ok(saveReceipt?.ok === true && savedTable[dir] === false, 'trust_save 落盘为 false')

    await trustHost.pi.commands[ext.NATIVE_COMMAND].handler(
      runtime.encodeEnvelope('tr-3', 'trust_save', { cwd: dir, decision: null }),
      trustHost.ctx
    )
    const deleted = JSON.parse(await readFile(join(dir, 'trust.json'), 'utf8'))
    ok(!(dir in deleted), 'trust_save decision=null 删除条目')
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    await rm(dir, { recursive: true, force: true })
  }

  /* 非法信封：回一条 bad_request，不崩 */
  const bad = makeFakeHost(ext)
  await bad.pi.commands[ext.NATIVE_COMMAND].handler('not-base64!!', bad.ctx)
  const badReceipt = receiptOf(bad.receipts.at(-1), runtime)
  ok(badReceipt?.ok === false && badReceipt.error?.code === 'bad_request', '坏参数回执 bad_request')
}

async function testHostRuntime(runtime) {
  console.log('宿主 NativeSessionRuntime')

  /** 假 transport：解码请求，用一个可控的 ctx 生成回执，再回灌 handleUi。 */
  function makeRuntime({ idle = true, dispatcher } = {}) {
    let instance
    const transport = {
      async command(_type, payload) {
        const message = String(payload.message)
        const encoded = message.slice(message.indexOf(' ') + 1)
        const envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
        const reply = dispatcher(envelope, { idle })
        queueMicrotask(() => instance.handleUi({ method: 'notify', message: reply.notify }))
        return reply.response
      }
    }
    instance = new runtime.NativeSessionRuntime(transport, 500)
    return instance
  }

  const hello = {
    notify: `${runtime.RECEIPT_PREFIX}${JSON.stringify({ v: 1, id: 'hello-1', op: 'hello', ok: true, result: { capabilities: ['navigate_tree', 'reload'] } })}`,
    response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
  }

  /* 未就绪：不发送任何命令（避免被当提问交给模型） */
  const cold = new runtime.NativeSessionRuntime({ command: async () => { throw new Error('不应被调用') } }, 200)
  let coldErr
  try {
    await cold.navigateTree('x')
  } catch (error) {
    coldErr = error
  }
  ok(coldErr?.code === 'bridge_unavailable', '未收到 hello 时拒绝发命令')

  /* 正常导航 */
  const navRuntime = makeRuntime({
    dispatcher: (envelope, { idle }) => {
      if (envelope.op === 'hello') return hello
      if (!idle) {
        return {
          notify: runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: false, error: { code: 'busy', message: '忙' } }),
          response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
        }
      }
      return {
        notify: runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: true, result: { cancelled: false, requestedTargetId: envelope.args.targetId, leafId: 'leaf-9', branchIds: ['leaf-9'] } }),
        response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
      }
    }
  })
  navRuntime.handleUi({ method: 'notify', message: hello.notify })
  ok(navRuntime.isReady === true && navRuntime.bridgeCapabilities.includes('navigate_tree'), 'hello 后标记就绪并记录能力')
  const nav = await navRuntime.navigateTree('mid-3', { summarize: false })
  ok(nav.ok === true && nav.entryId === 'mid-3' && nav.leafId === 'leaf-9' && nav.cancelled === false, '导航回执解析为结构化结果')

  /* 读出 scoped models：运行时条目 + 原始 pattern */
  const scopedRuntime = makeRuntime({
    dispatcher: (envelope) => {
      if (envelope.op === 'hello') return hello
      return {
        notify: runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: true, result: { scoped: [{ provider: 'a', id: 'b', name: 'B', thinkingLevel: 'high' }], enabledModels: ['a/b'] } }),
        response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
      }
    }
  })
  scopedRuntime.handleNotify(hello.notify)
  const snapshot = await scopedRuntime.getScopedModels()
  ok(snapshot.scopedModels[0]?.key === 'a/b' && snapshot.scopedModels[0]?.thinkingLevel === 'high', 'getScopedModels 返回 provider/id key')
  ok(snapshot.scopeIsAll === false && snapshot.enabledModels[0] === 'a/b', 'getScopedModels 带原始 pattern 与 scopeIsAll')

  /* 写 scoped models：只持久化 + 标注重启生效 */
  const saveRuntime = makeRuntime({
    dispatcher: (envelope) => ({
      notify: runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: true, result: { settingsFile: '/agent/settings.json', patterns: ['a/b'], effective: 'next-session' } }),
      response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
    })
  })
  saveRuntime.handleNotify(hello.notify)
  const saved = await saveRuntime.saveScopedModels(['a/b'])
  ok(saved.ok === true && saved.requiresRestart === true && saved.enabledModels[0] === 'a/b' && saved.settingsPath.includes('settings.json'), 'saveScopedModels 回执映射为持久化结果')

  /* 项目信任：自身条目 vs 祖先条目 */
  const trustRuntime = makeRuntime({
    dispatcher: (envelope) => {
      const result = envelope.args.decision === undefined
        ? { cwd: 'C:\\proj', entry: 'C:\\proj', decision: true }
        : { cwd: 'C:\\proj', entry: 'C:\\proj', decision: envelope.args.decision }
      return {
        notify: runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: true, result }),
        response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
      }
    }
  })
  trustRuntime.handleNotify(hello.notify)
  const trust = await trustRuntime.getProjectTrust()
  ok(trust.effectiveTrusted === true && trust.explicitDecision === true && trust.ancestorTrustPath === null, 'getProjectTrust：自身条目 = explicitDecision')
  const savedTrust = await trustRuntime.saveProjectTrust(false)
  ok(savedTrust.ok === true && savedTrust.requiresRestart === true, 'saveProjectTrust 返回需要重建实例')

  const ancestorRuntime = makeRuntime({
    dispatcher: (envelope) => ({
      notify: runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: true, result: { cwd: 'C:\\proj\\sub', entry: 'C:\\proj', decision: true } }),
      response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
    })
  })
  ancestorRuntime.handleNotify(hello.notify)
  const ancestor = await ancestorRuntime.getProjectTrust()
  ok(ancestor.effectiveTrusted === true && ancestor.explicitDecision === false && ancestor.ancestorTrustPath === 'C:\\proj', 'getProjectTrust：祖先条目 = ancestorTrustPath')

  /* reload 以完成回执为准 */
  const reloadRuntime = makeRuntime({
    dispatcher: (envelope) => ({
      notify: runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: true, result: { phase: 'completed' } }),
      response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
    })
  })
  reloadRuntime.handleNotify(hello.notify)
  const reloaded = await reloadRuntime.reload()
  ok(reloaded.ok === true, 'reload 以完成回执判定成功')

  /* busy 回执 → NativeBridgeError('busy') */
  const busyRuntime = makeRuntime({ idle: false, dispatcher: (envelope) => {
    if (envelope.op === 'hello') return hello
    return {
      notify: runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: false, error: { code: 'busy', message: '会话不空闲' } }),
      response: { success: true, command: 'prompt', data: { disposition: 'handled' } }
    }
  } })
  busyRuntime.handleUi({ method: 'notify', message: hello.notify })
  let busyErr
  try {
    await busyRuntime.reload()
  } catch (error) {
    busyErr = error
  }
  ok(busyErr?.code === 'busy', 'busy 回执映射为 NativeBridgeError(busy)')

  /* 命令没被识别 → 立刻报错，不等待、不重发 */
  const notHandled = new runtime.NativeSessionRuntime({
    command: async () => ({ success: true, command: 'prompt', data: { disposition: 'started' } })
  }, 300)
  notHandled.handleUi({ method: 'notify', message: hello.notify })
  let notHandledErr
  try {
    await notHandled.navigateTree('x')
  } catch (error) {
    notHandledErr = error
  }
  ok(notHandledErr?.code === 'command_not_handled', 'disposition 非 handled 时以 command_not_handled 中止')

  /* 超时 */
  const stalled = new runtime.NativeSessionRuntime({
    command: async () => ({ success: true, command: 'prompt', data: { disposition: 'handled' } })
  }, 80)
  stalled.handleUi({ method: 'notify', message: hello.notify })
  let timeoutErr
  const started = Date.now()
  try {
    await stalled.navigateTree('x')
  } catch (error) {
    timeoutErr = error
  }
  ok(timeoutErr?.code === 'timeout' && Date.now() - started >= 60, '回执迟到时报超时')

  /* 回执必须是本桥前缀才消费 */
  const rt = new runtime.NativeSessionRuntime({ command: async () => hello.response }, 200)
  ok(rt.handleUi({ method: 'notify', message: '普通通知' }) === false, '普通通知不被拦截')
  ok(rt.handleUi({ method: 'setStatus', message: hello.notify }) === false, '非 notify 方法不被拦截')

  /* 顶层 await + esbuild 产物存在性（防陈旧产物）
     这里只做一次导入即可，产物由 loadRuntime 生成 */
  ok(typeof runtime.NativeSessionRuntime === 'function', '宿主模块可加载')
}

async function main() {
  const ext = await loadExtension()
  const runtime = await loadRuntime()

  await testTrust(ext, await mkdtemp(join(tmpdir(), 'inkstone-native-trust-')))
  await testSettings(ext, await mkdtemp(join(tmpdir(), 'inkstone-native-set-')))
  await testEnvelopeAndReceipt(ext, runtime)
  await testExtensionHandlers(ext, runtime)
  await testHostRuntime(runtime)

  /* 产物目录已存在即可，测试不改动源码 */
  ok(existsSync(join(process.cwd(), 'resources', 'pi-extensions', 'native-session-bridge.js')), '扩展资源文件存在')

  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
