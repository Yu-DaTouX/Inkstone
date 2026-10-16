import { build } from 'esbuild'

let checks = 0
const failures = []
const ok = (condition, message, detail) => {
  checks += 1
  if (!condition) {
    failures.push(message)
    console.log(`✗ ${message}${detail !== undefined ? `（${detail}）` : ''}`)
  } else {
    console.log(`✓ ${message}`)
  }
}

let mod
try {
  const bundled = await build({
    stdin: {
      contents:
        "export * from './src/main/mcp/app-theme';" + "export * from './src/main/mcp/app-view-service';",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
} catch (error) {
  console.error(`无法加载被测模块：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const {
  McpAppViewService,
  resolveMcpAppThemeValue,
  resolveMcpAppThemeVariables,
  buildMcpAppHostContext,
  isMcpAppTheme,
  MCP_APP_DEFAULT_THEME
} = mod
ok(typeof McpAppViewService === 'function', '加载 McpAppViewService')
ok(typeof resolveMcpAppThemeValue === 'function', '加载 resolveMcpAppThemeValue')
ok(typeof buildMcpAppHostContext === 'function', '加载 buildMcpAppHostContext')

ok(resolveMcpAppThemeValue('light-dark(#FFFFFF, #272725)', 'light') === '#FFFFFF', '浅色取 light-dark 左侧')
ok(resolveMcpAppThemeValue('light-dark(#FFFFFF, #272725)', 'dark') === '#272725', '深色取 light-dark 右侧')
ok(
  resolveMcpAppThemeValue('light-dark(rgba(64,87,214,.10), rgba(142,161,245,.14))', 'light') ===
    'rgba(64,87,214,.10)',
  '嵌套 rgba 的逗号不误拆（浅色）'
)
ok(
  resolveMcpAppThemeValue('light-dark(rgba(64,87,214,.10), rgba(142,161,245,.14))', 'dark') ===
    'rgba(142,161,245,.14)',
  '嵌套 rgba 的逗号不误拆（深色）'
)
ok(
  resolveMcpAppThemeValue('0 0 0 1px light-dark(rgba(29,29,27,.08), rgba(255,255,255,.08))', 'light') ===
    '0 0 0 1px rgba(29,29,27,.08)',
  'box-shadow 内嵌 light-dark 解析成浅色描边'
)
ok(
  resolveMcpAppThemeValue('0 0 0 1px light-dark(rgba(29,29,27,.08), rgba(255,255,255,.08))', 'dark') ===
    '0 0 0 1px rgba(255,255,255,.08)',
  'box-shadow 内嵌 light-dark 解析成深色描边'
)
ok(resolveMcpAppThemeValue('transparent', 'dark') === 'transparent', '不含 light-dark 的值原样保留')
ok(
  resolveMcpAppThemeValue('light-dark(#FFF', 'light') === 'light-dark(#FFF',
  '形状不合法时原样返回，不猜测'
)

const lightVars = resolveMcpAppThemeVariables('light')
const darkVars = resolveMcpAppThemeVariables('dark')
ok(lightVars['--color-background-primary'] === '#FFFFFF', '浅色主背景是具体值')
ok(darkVars['--color-background-primary'] === '#272725', '深色主背景是具体值')
ok(lightVars['--color-text-primary'] === '#1D1D1B' && darkVars['--color-text-primary'] === '#ECECE9', '文字主色按主题取值')
ok(
  lightVars['--shadow-hairline'] === '0 0 0 1px rgba(29,29,27,.08)' &&
    darkVars['--shadow-hairline'] === '0 0 0 1px rgba(255,255,255,.08)',
  '细线阴影按主题取值，不是 light-dark'
)
ok(
  typeof lightVars['--shadow-md'] === 'string' &&
    typeof darkVars['--shadow-md'] === 'string' &&
    lightVars['--shadow-md'] !== darkVars['--shadow-md'],
  '阴影 md 按主题单独取值'
)
ok(
  Object.values(lightVars).every((value) => !value.includes('light-dark(')) &&
    Object.values(darkVars).every((value) => !value.includes('light-dark(')),
  '两套解析结果都不含 light-dark('
)
ok(
  Object.keys(lightVars).length > 40 && Object.keys(lightVars).length === Object.keys(darkVars).length,
  '两套变量键集合一致且数量合理',
  String(Object.keys(lightVars).length)
)

const providerWithExtra = {
  platform: 'desktop',
  displayMode: 'fullscreen',
  availableDisplayModes: ['inline', 'fullscreen', 'pip'],
  locale: 'zh-CN',
  timeZone: 'Asia/Shanghai',
  deviceCapabilities: { hover: true },
  styles: {
    variables: { '--brand': '#123456', '--color-text-primary': 'provider-should-lose' },
    css: { fonts: 'body { color: red }' }
  }
}
const built = buildMcpAppHostContext({ theme: 'light', provider: providerWithExtra })
ok(built.theme === 'light', '合成后 theme 为宿主明确主题')
ok(built.platform === 'desktop' && built.displayMode === 'fullscreen', '不覆盖 provider 的 platform / displayMode')
ok(built.locale === 'zh-CN' && built.timeZone === 'Asia/Shanghai', '保留 provider 的 locale / timeZone')
ok(built.deviceCapabilities?.hover === true, '保留 provider 的 deviceCapabilities')
ok(built.styles?.variables?.['--brand'] === '#123456', '合并 provider 自定义变量')
ok(built.styles?.variables?.['--color-text-primary'] === '#1D1D1B', '标准主题变量覆盖 provider 同名值')
ok(!('css' in (built.styles ?? {})), '不透传 provider 的 styles.css（不放任任意样式注入）')

const defaults = buildMcpAppHostContext({ theme: 'dark' })
ok(defaults.platform === 'desktop' && defaults.displayMode === 'inline', 'provider 缺省时补桌面默认值')
ok(Array.isArray(defaults.availableDisplayModes) && defaults.availableDisplayModes.includes('fullscreen'), '补上 availableDisplayModes')

const badProvider = {
  platform: 'mobile',
  displayMode: 'pip',
  theme: 'light',
  styles: {
    variables: {
      '--ok': 'value',
      color: 'not-a-custom-property',
      '--semi': 'a;b',
      '--newline': 'a\nb',
      '--number': 5
    }
  }
}
const sanitized = buildMcpAppHostContext({ theme: 'dark', provider: badProvider })
ok(sanitized.theme === 'dark' && isMcpAppTheme(sanitized.theme), 'provider 的 theme 不能顶掉宿主明确主题')
ok(sanitized.styles.variables['--ok'] === 'value', '合法自定义变量保留')
ok(
  !('color' in sanitized.styles.variables) &&
    !('--semi' in sanitized.styles.variables) &&
    !('--newline' in sanitized.styles.variables) &&
    !('--number' in sanitized.styles.variables),
  '坏键 / 带分号 / 带换行 / 非字符串变量被过滤'
)

const SERVER = 'srv'
const SERVER_CONFIG = {
  id: SERVER,
  transport: 'stdio',
  command: 'node',
  args: ['x.mjs'],
  enabled: true,
  ownedBy: 'inkstone'
}
const FACTS = {
  sessionId: 's1',
  sessionFile: '/sessions/s1.jsonl',
  projectId: 'p1',
  runnerId: 'r1',
  generation: 1,
  cwd: 'C:/proj',
  title: 'Demo App'
}
const RECORD = {
  callId: 'call-1',
  owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 1 },
  serverId: SERVER,
  toolName: 'read',
  text: '',
  resourceUri: 'ui://srv/app.html'
}

function makeService(extra = {}) {
  const options = {
    proxy: {
      getCallResult: () => RECORD,
      snapshotStatus: () => ({ present: true, stale: false, needsRefresh: false }),
      registrableTools: () => [],
      refresh: async () => ({ ok: true, toolCount: 0 })
    },
    host: {
      listToolsWithMeta: async () => [],
      callToolWithMeta: async () => ({
        result: { content: [] },
        meta: {},
        structuredContent: null,
        resourceUri: null,
        uiCsp: null,
        isError: false,
        text: ''
      }),
      readResource: async (serverId, uri) => ({
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: '<html></html>',
        bytes: 13,
        meta: null,
        uiCsp: null
      })
    },
    ownerGuard: { isActive: () => true },
    runtime: { resolve: async () => FACTS, currentProject: async () => 'p1' },
    ask: () => 'deny',
    audit: { record: async () => ({}), read: async () => [], clearSession() {} },
    serverConfigOf: (id) => (id === SERVER ? SERVER_CONFIG : null),
    fetchResource: async () => ({ html: '<html></html>', mimeType: 'text/html;profile=mcp-app', bytes: 13, csp: "default-src 'none'" })
  }
  Object.assign(options, extra)
  return new McpAppViewService(options)
}

const rpc = (method, params, id) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })

async function initializeContext(service) {
  const prepared = await service.prepare('call-1')
  if (prepared.kind !== 'ready') throw new Error(`prepare 失败：${prepared.kind}`)
  const response = await service.dispatch(prepared.instanceId, rpc('ui/initialize', {}, 1))
  return response?.result?.hostContext
}

await (async () => {
  const context = await initializeContext(makeService())
  ok(context?.theme === MCP_APP_DEFAULT_THEME, '缺省主题回退到宿主默认（非浅色）', String(context?.theme))
  ok(context?.platform === 'desktop' && context?.displayMode === 'inline', '缺省仍有 platform / displayMode')
  ok(
    context?.styles?.variables?.['--color-text-primary'] === '#ECECE9',
    '首次 initialize 带 hostContext.styles.variables（深色具体值）',
    JSON.stringify(context?.styles?.variables?.['--color-text-primary'])
  )
  ok(
    Object.values(context?.styles?.variables ?? {}).every((value) => !String(value).includes('light-dark(')),
    'initialize 响应里没有 light-dark'
  )

  const lightContext = await initializeContext(makeService({ theme: async () => 'light' }))
  ok(lightContext?.theme === 'light', 'theme provider 生效')
  ok(lightContext?.styles?.variables?.['--color-background-primary'] === '#FFFFFF', '浅色 provider 给出浅色值')

  const providerContext = await initializeContext(
    makeService({
      hostContext: () => ({
        platform: 'desktop',
        displayMode: 'pip',
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        locale: 'zh-CN',
        styles: { variables: { '--brand': '#123456', '--color-text-primary': 'provider' }, css: { fonts: 'x' } }
      })
    })
  )
  ok(providerContext?.displayMode === 'pip', '保留 provider 的 displayMode，不被主题覆盖')
  ok(providerContext?.locale === 'zh-CN', '保留 provider 的 locale')
  ok(providerContext?.styles?.variables?.['--brand'] === '#123456', '合并 provider 自定义变量')
  ok(
    providerContext?.styles?.variables?.['--color-text-primary'] === '#ECECE9',
    '标准主题变量覆盖 provider 同名值'
  )
  ok(!('css' in (providerContext?.styles ?? {})), 'provider 的 styles.css 不透传')

  const throwing = await initializeContext(
    makeService({
      hostContext: () => {
        throw new Error('provider boom')
      },
      theme: () => {
        throw new Error('theme boom')
      }
    })
  )
  ok(throwing?.platform === 'desktop' && throwing?.theme === MCP_APP_DEFAULT_THEME, 'provider / theme 抛错时仍返回可用宿主上下文')
  ok(typeof throwing?.styles?.variables?.['--color-text-primary'] === 'string', '抛错回退也带主题变量')

  const providerTheme = await initializeContext(makeService({ hostContext: () => ({ theme: 'light' }) }))
  ok(providerTheme?.theme === 'light', '无显式 provider 时 theme 字段可作为主题线索')
})()

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
