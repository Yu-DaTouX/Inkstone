import './lib/test-isolate.mjs'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { runSuite } from './lib/test-suite.mjs'

const rnStub = { name: 'rn-stub', setup(b) {
  b.onResolve({ filter: /^react-native$/ }, () => ({ path: 'rn', namespace: 'stub' }))
  b.onResolve({ filter: /^@noble\/(curves|ciphers)\// }, () => ({ path: 'noble', namespace: 'stub' }))
  b.onLoad({ filter: /^rn$/, namespace: 'stub' }, () => ({ contents: 'const rn = globalThis.__rn; export const Platform = rn.Platform; export const NativeModules = rn.NativeModules; export const PermissionsAndroid = rn.PermissionsAndroid', loader: 'js' }))
  b.onLoad({ filter: /^noble$/, namespace: 'stub' }, () => ({ contents: 'export const p256 = { getPublicKey: () => new Uint8Array(65) }; export const gcm = () => ({})', loader: 'js' }))
} }

function block(source, start) {
  const from = source.indexOf(start)
  if (from < 0) return ''
  const open = source.indexOf('{', from + start.length - 1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(from, i + 1)
  }
  return ''
}

await runSuite(import.meta.url, async (ok) => {
  const calls = []
  let enabled = false
  const rn = globalThis.__rn = {
    Platform: { OS: 'android', Version: 30 },
    NativeModules: { InkstoneQuestionAlerts: {
      start: async (...args) => { calls.push(['start', ...args]); return true },
      stop: async () => true,
      status: async () => { calls.push(['status']); return { enabled, wanted: false, active: false } },
      openSettings: async () => true
    } },
    PermissionsAndroid: {
      PERMISSIONS: { POST_NOTIFICATIONS: 'post' },
      RESULTS: { GRANTED: 'granted' },
      check: async () => { calls.push(['check']); return true },
      request: async () => 'granted'
    }
  }
  const built = await build({ entryPoints: ['mobile/src/questionAlerts.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', plugins: [rnStub] })
  const { startQuestionAlerts } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const connection = { baseUrl: 'relay://pc', relay: { direct: ['ws://pc:1/remote/v1/tunnel'], hostKey: 'h', clientKey: 'AAAA' }, token: 't', deviceId: 'd' }

  ok(await startQuestionAlerts(connection, true) === false, 'Android 12 及以下通知被关时不报开启成功')
  ok(!calls.some(([name]) => name === 'start'), 'Android 12 及以下通知被关时不启动前台服务', JSON.stringify(calls))
  calls.length = 0
  enabled = true
  ok(await startQuestionAlerts(connection, true) === true && calls.some(([name]) => name === 'start'), 'Android 12 及以下通知开着时照常启动')
  calls.length = 0
  rn.Platform.Version = 34
  ok(await startQuestionAlerts(connection, true) === true && calls.some(([name]) => name === 'check'), 'Android 13 起仍走运行时权限检查')

  const moduleSource = readFileSync('mobile/android/app/src/main/java/com/yudatoux/inkstone/QuestionAlertModule.kt', 'utf8')
  const start = block(moduleSource, 'fun start(')
  const gate = start.indexOf('areNotificationsEnabled()')
  ok(gate >= 0 && gate < start.indexOf('startForegroundService'), '原生 start 先确认通知可用再启动前台服务')
  ok(start.indexOf('putBoolean("wanted", true)') > start.indexOf('startForegroundService'), '只在真正启动后记下 wanted')

  const serviceSource = readFileSync('mobile/android/app/src/main/java/com/yudatoux/inkstone/QuestionAlertService.kt', 'utf8')
  const command = block(serviceSource, 'override fun onStartCommand(')
  const invalid = block(command, 'if (baseUrl.isNullOrBlank()')
  ok(invalid.includes('stopSelf()'), '参数或通知不满足时服务自行退出')
  const promote = invalid.search(/startForeground\(|promoteToForeground\(/)
  ok(promote >= 0 && promote < invalid.indexOf('stopSelf()'), '退出前先进入前台，满足 startForegroundService 的时限要求', invalid)
})
