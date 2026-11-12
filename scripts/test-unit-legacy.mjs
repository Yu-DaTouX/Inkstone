import { build } from 'esbuild'
import { buildTest } from './lib/test-suite.mjs'
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTestEnv, isIsolatedTestEnv } from './lib/test-env.mjs'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { runHtmlArtifactPreviewTests } from './test-html-artifact-preview.mjs'
import { runRunStateTests } from './test-run-state.mjs'
import { runCapabilityNegotiationTests } from './test-capability-negotiation.mjs'
import { runSessionConcurrencyConflictTests, runSessionConcurrencySendGuardTests } from './test-session-concurrency-runners.mjs'
import { runSessionConcurrencyFrontendTests, runSessionConcurrencyFinalEdgesTests } from './test-session-concurrency-frontend.mjs'
import { runSessionStatsIsolationTests } from './test-session-stats-isolation.mjs'
import { runCommandCodeQuotaDisplayTests } from './test-commandcode-quota-display.mjs'
import { runSubagentActiveVisibilityTests } from './test-subagent-active-visibility.mjs'
import { runSubagentParentOwnershipTests } from './test-subagent-parent-ownership.mjs'
import { runSessionSyncRaceTests } from './test-session-sync-race.mjs'
import { runHostOwnershipTests } from './test-host-ownership.mjs'
import { runSnapshotIdentityTests } from './test-snapshot-identity.mjs'
import { runExecutionAdmissionTests } from './test-execution-admission.mjs'
import { runEpochSnapshotTests } from './test-epoch-snapshot.mjs'
import { runAccountQuotaPaneTests } from './test-account-quota-pane.mjs'
import { runFileContentSearchTests } from './test-file-content-search.mjs'
import { runFileEditorTests } from './test-file-editor.mjs'

if (!isIsolatedTestEnv()) applyTestEnv()
const isolatedEnv = isIsolatedTestEnv()

const inProcessFailures = []
async function guarded(label, run) {
  try {
    await run()
  } catch (error) {
    console.log(`✗ ${label}：${error?.message ?? error}`)
    inProcessFailures.push({ label, detail: error?.stack ?? String(error) })
  }
}

await guarded("import('./test-live-synthetic-isolation.mjs')", () => import('./test-live-synthetic-isolation.mjs'))
await guarded("import('./test-light-client.mjs')", () => import('./test-light-client.mjs'))
await guarded("import('./test-light-hotpaths.mjs')", () => import('./test-light-hotpaths.mjs'))
await guarded("import('./test-main-runtime-imports.mjs')", () => import('./test-main-runtime-imports.mjs'))
await guarded("import('./test-i18n-consistency.mjs')", () => import('./test-i18n-consistency.mjs'))
await guarded("import('./test-i18n-compare.mjs')", () => import('./test-i18n-compare.mjs'))
await guarded("import('./test-model-selection.mjs')", () => import('./test-model-selection.mjs'))
await guarded("import('./test-cc-guard.mjs')", () => import('./test-cc-guard.mjs'))
await guarded("runHtmlArtifactPreviewTests()", () => runHtmlArtifactPreviewTests())
await guarded("runRunStateTests()", () => runRunStateTests())
await guarded("runCapabilityNegotiationTests()", () => runCapabilityNegotiationTests())
await guarded("import('./test-security-performance-fixes.mjs')", () => import('./test-security-performance-fixes.mjs'))
await guarded("import('./test-browser-frame-origin.mjs')", () => import('./test-browser-frame-origin.mjs'))
await guarded("import('./test-v3-deeplink.mjs')", () => import('./test-v3-deeplink.mjs'))
const inProcessScripts = [
  'test-attachment-prune-race', 'test-files-root-boundary',
  'test-mobile-model-url', 'test-mobile-window-layout', 'test-mobile-timeline', 'test-mobile-event-stream', 'test-mobile-image-cache', 'test-mobile-preview-plan', 'test-open-path-boundary',
  'test-package-timeout-fallback',
  'test-session-restore-rollback', 'test-subagent-stop-intent',
  'test-title-lifecycle', 'test-write-file-durable', 'test-project-directory',
  'test-user-address',
  'test-pi-settings-eperm-retry'
]
for (const script of inProcessScripts) {
  if (script === 'test-mobile-event-stream' && !existsSync(join('mobile', 'node_modules', '@noble', 'curves'))) {
    console.log(`- ${script}（跳过：worktree 未安装 mobile 依赖）`)
    continue
  }
  await guarded(script, () => import(`./${script}.mjs`))
}

const dir = await mkdtemp(join(tmpdir(), 'yan-sessions-'))
const dataDir = await mkdtemp(join(tmpdir(), 'yan-data-'))
process.env.YAN_SESSIONS_DIR = dir
process.env.YAN_DATA_DIR = dataDir

const { listSessions, deleteSession, readTitleSamples, restoreSession, SESSIONS_DIR } = await import('../out/main/sessions.js')

await buildTest('src/shared/turns.ts', 'out/test/turns.mjs', { platform: 'neutral' })

await buildTest('src/shared/turn-timing.ts', 'out/test/turn-timing.mjs', { platform: 'neutral' })

await buildTest('src/shared/file-resource.ts', 'out/test/file-resource.mjs', { platform: 'neutral' })

await buildTest('src/shared/duration.ts', 'out/test/duration.mjs', { platform: 'neutral' })

await buildTest('src/main/turn-timing-store.ts', 'out/test/turn-timing-store.mjs')

await buildTest('src/main/zoom-math.ts', 'out/test/zoom-math.mjs', { platform: 'neutral' })

await buildTest('src/main/agent.ts', 'out/test/agent.mjs', { external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'], plugins: [{ name: 'unit-electron-boundary', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'unit-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'unit-electron' }, () => ({ contents: `
        export class BrowserWindow { constructor() { throw new Error('Native browser requires an Electron integration test') } }
        export const session = { fromPartition() { throw new Error('Native session requires an Electron integration test') } }
        export const app = {
          getLocale: () => 'zh-CN',
          getPath: (name) => {
            const root = process.env.YAN_TEST_APP_DIR || process.env.YAN_DATA_DIR || (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/inkstone-unit-app'
            return root + '/' + (name || 'documents')
          }
        }
      ` }))
    } }] })

await buildTest('src/main/artifacts.ts', 'out/test/artifacts.mjs')
await buildTest('src/main/image-generation.ts', 'out/test/image-generation.mjs')
await buildTest('src/renderer/src/state/keep-images.ts', 'out/test/keep-images.mjs', { platform: 'neutral' })
await buildTest('src/main/attachments.ts', 'out/test/attachments.mjs')
const { runAttachmentTests } = await import('./test-attachments.mjs')
const { runKeepImagesTests } = await import('./test-keep-images.mjs')
await buildTest('src/renderer/src/state/same-messages.ts', 'out/test/same-messages.mjs', { platform: 'neutral' })
const { runSameMessagesTests, runStableRefTests } = await import('./test-same-messages.mjs')
await buildTest('src/renderer/src/state/stable-ref.ts', 'out/test/stable-ref.mjs', { platform: 'neutral' })
await buildTest('src/main/session-reader.ts', 'out/test/session-reader.mjs')
const { runSessionImageTests } = await import('./test-session-images.mjs')
const { runArtifactTests } = await import('./test-artifacts.mjs')
await guarded("runArtifactTests()", () => runArtifactTests())
await guarded("import('./test-image-generation-boundaries.mjs')", () => import('./test-image-generation-boundaries.mjs'))
await guarded("import('./test-bundled-plugins.mjs')", () => import('./test-bundled-plugins.mjs'))
await guarded("import('./test-comfyui-plugin.mjs')", () => import('./test-comfyui-plugin.mjs'))
const { runTurnTests } = await import('./test-turns.mjs')
const { runTurnTimingTests } = await import('./test-turn-timing.mjs')
const { runDurationTests } = await import('./test-duration.mjs')
const { runTurnTimingStoreTests } = await import('./test-turn-timing.mjs')
const { runZoomTests } = await import('./test-zoom.mjs')
const { runFileRefTests } = await import('./test-filerefs.mjs')
const { runLinkTests } = await import('./test-links.mjs')
const { runFileResourceTests } = await import('./test-file-resource.mjs')
const { runWorkbenchTests } = await import('./test-workbench.mjs')
const { runSubagentViewTests } = await import('./test-subagent-view.mjs')
const { runSubagentUsageTests } = await import('./test-subagent-usage.mjs')
const { runBrowserVisibilityTests } = await import('./test-browser-visibility.mjs')
const { runBrowserNavigationTests } = await import('./test-browser-navigation.mjs')
const { runResponseDetailTests } = await import('./test-response-detail.mjs')
const { runSnapshotTests } = await import('./test-snapshots.mjs')

await buildTest('src/main/snapshots.ts', 'out/test/snapshots.mjs')

await buildTest('src/shared/links.ts', 'out/test/links.mjs', { platform: 'neutral' })

await buildTest('src/shared/browser-navigation.ts', 'out/test/browser-navigation.mjs', { platform: 'neutral' })

await buildTest('src/renderer/src/state/workspace-key.ts', 'out/test/workbench.mjs', { platform: 'neutral' })

await buildTest('src/shared/subagent-usage.ts', 'out/test/subagent-usage.mjs', { platform: 'neutral' })

await buildTest('src/renderer/src/state/subagent-view.ts', 'out/test/subagent-view.mjs', { platform: 'neutral' })

await buildTest('src/renderer/src/state/browser-visibility.ts', 'out/test/browser-visibility.mjs', { platform: 'neutral' })

await buildTest('src/main/file-refs.ts', 'out/test/file-refs.mjs')

await buildTest('src/main/chrome-profile.ts', 'out/test/chrome-profile.mjs')
const { runChromeProfileTests } = await import('./test-chrome-profile.mjs')

await buildTest('src/shared/ipc.ts', 'out/test/ipc.mjs', { platform: 'neutral' })
const { runQuestionTests } = await import('./test-question.mjs')

await buildTest('src/main/todo-snapshots.ts', 'out/test/todo-snapshots.mjs', { platform: 'neutral' })
const { runTodoHistoryTests } = await import('./test-todo-history.mjs')
const { runRepeatGuardTests } = await import('./test-repeat-guard.mjs')

const taskPlan = await buildTest('src/shared/task-plan.ts', 'out/test/task-plan.mjs', { platform: 'neutral' }).then(() => import('../out/test/task-plan.mjs'))
const { runTaskPlanTests } = await import('./test-task-plan.mjs')

await buildTest('src/main/task-plan-store.ts', 'out/test/task-plan-store.mjs')
const { runTaskPlanStoreTests } = await import('./test-task-plan-store.mjs')

const capabilityCatalogShared = await buildTest('src/shared/capabilities.ts', 'out/test/capabilities.mjs', { platform: 'neutral' }).then(() => import('../out/test/capabilities.mjs'))
const capabilitySkillService = await buildTest('src/main/capabilities/skill-service.ts', 'out/test/capabilities-skill.mjs').then(() => import('../out/test/capabilities-skill.mjs'))
const capabilityCatalogMain = await buildTest('src/main/capabilities/catalog.ts', 'out/test/capabilities-catalog.mjs').then(() => import('../out/test/capabilities-catalog.mjs'))
const { runCapabilityCatalogTests } = await import('./test-capabilities.mjs')

const discoveryShared = await buildTest('src/shared/discovery.ts', 'out/test/discovery.mjs').then(() => import('../out/test/discovery.mjs'))
const discoveryMain = await buildTest('src/main/capabilities/discovery/discover.ts', 'out/test/discovery-src.mjs').then(() => import('../out/test/discovery-src.mjs'))
const { runDiscoveryTests } = await import('./test-discovery.mjs')

const acquisitionShared = await buildTest('src/shared/acquisition.ts', 'out/test/acquisition.mjs').then(() => import('../out/test/acquisition.mjs'))
const skillSecurity = await buildTest('src/shared/skill-security.ts', 'out/test/skill-security.mjs', { platform: 'neutral' }).then(() => import('../out/test/skill-security.mjs'))
const acquisitionService = await buildTest('src/main/capabilities/acquisition-service.ts', 'out/test/acquisition-service.mjs').then(() => import('../out/test/acquisition-service.mjs'))
const piPackageScheduler = await buildTest('src/main/capabilities/pi-package-scheduler.ts', 'out/test/pi-package-scheduler.mjs').then(() => import('../out/test/pi-package-scheduler.mjs'))
const npmArtifact = await buildTest('src/main/capabilities/npm-artifact.ts', 'out/test/npm-artifact.mjs', { external: ['tar'] }).then(() => import('../out/test/npm-artifact.mjs'))
const npmAcquisition = await buildTest('src/main/capabilities/npm-acquisition.ts', 'out/test/npm-acquisition.mjs', { external: ['tar'] }).then(() => import('../out/test/npm-acquisition.mjs'))
const packageAuthorizationShared = await buildTest('src/shared/package-authorization.ts', 'out/test/package-authorization.mjs').then(() => import('../out/test/package-authorization.mjs'))
const packageAuthorizationService = await buildTest('src/main/capabilities/package-authorization-service.ts', 'out/test/package-authorization-service.mjs').then(() => import('../out/test/package-authorization-service.mjs'))
const piPackageSmoke = await buildTest('src/main/capabilities/pi-package-smoke.ts', 'out/test/pi-package-smoke.mjs', { external: ['tar'] }).then(() => import('../out/test/pi-package-smoke.mjs'))
const { runAcquisitionTests } = await import('./test-acquisition.mjs')
const { runSkillSecurityTests } = await import('./test-skill-security.mjs')
const { runPiPackageSchedulerTests } = await import('./test-pi-package-scheduler.mjs')
const { runPiPackageSmokeTests } = await import('./test-pi-package-smoke.mjs')

const mcpShared = await buildTest('src/shared/mcp.ts', 'out/test/mcp.mjs', { platform: 'neutral' }).then(() => import('../out/test/mcp.mjs'))
const mcpConfig = await buildTest('src/main/mcp/config.ts', 'out/test/mcp-config.mjs').then(() => import('../out/test/mcp-config.mjs'))
const mcpManager = await buildTest('src/main/mcp/connection-manager.ts', 'out/test/mcp-manager.mjs', { external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'] }).then(() => import('../out/test/mcp-manager.mjs'))
const mcpToolService = await buildTest('src/main/mcp/tool-service.ts', 'out/test/mcp-tool.mjs', { external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'] }).then(() => import('../out/test/mcp-tool.mjs'))
const { runMcpTests } = await import('./test-mcp.mjs')


await buildTest('src/main/extensions-inventory.ts', 'out/test/extensions-inventory.mjs')
const { runExtensionInventoryTests } = await import('./test-extension-inventory.mjs')

const subagentIsolation = await buildTest('src/main/subagent-isolation.ts', 'out/test/subagent-isolation.mjs').then(() => import('../out/test/subagent-isolation.mjs'))
const { runSubagentIsolationTests } = await import('./test-subagent-isolation.mjs')

const { SubagentController } = await buildTest('src/main/subagents.ts', 'out/test/subagents.mjs').then(() => import('../out/test/subagents.mjs'))
const { runSubagentControllerTests } = await import('./test-subagents.mjs')

const projectId = await buildTest('src/main/project-id.ts', 'out/test/project-id.mjs').then(() => import('../out/test/project-id.mjs'))
const { runProjectIdTests } = await import('./test-project-id.mjs')

const projectSession = await buildTest('src/renderer/src/state/project-session.ts', 'out/test/project-session.mjs', { platform: 'neutral' }).then(() => import('../out/test/project-session.mjs'))
const { runProjectSessionTests } = await import('./test-project-session.mjs')

const pushRouting = await buildTest('src/renderer/src/state/push-routing.ts', 'out/test/push-routing.mjs', { platform: 'neutral' }).then(() => import('../out/test/push-routing.mjs'))

const sessionLayout = await buildTest('src/main/session-layout.ts', 'out/test/session-layout.mjs').then(() => import('../out/test/session-layout.mjs'))

const exitSnapshot = await buildTest('src/main/exit-snapshot.ts', 'out/test/exit-snapshot.mjs').then(() => import('../out/test/exit-snapshot.mjs'))

const commandRegistry = await buildTest('src/main/command-registry.ts', 'out/test/command-registry.mjs', { platform: 'neutral' }).then(() => import('../out/test/command-registry.mjs'))

const modelCapabilities = await buildTest('src/shared/model-capabilities.ts', 'out/test/model-capabilities.mjs', { platform: 'neutral' }).then(() => import('../out/test/model-capabilities.mjs'))

const buildInfo = await buildTest('src/shared/build-info.ts', 'out/test/build-info.mjs', { platform: 'neutral' }).then(() => import('../out/test/build-info.mjs'))

const networkPolicy = await buildTest('src/main/browser/network-policy.ts', 'out/test/network-policy.mjs').then(() => import('../out/test/network-policy.mjs'))

const manualTitle = await buildTest('src/main/title.ts', 'out/test/title.mjs').then(() => import('../out/test/title.mjs'))

const networkBoundary = await buildTest('src/main/browser/network-boundary.ts', 'out/test/network-boundary.mjs').then(() => import('../out/test/network-boundary.mjs'))

const pinnedResolver = await buildTest('src/main/net/pinned-resolver.ts', 'out/test/pinned-resolver.mjs').then(() => import('../out/test/pinned-resolver.mjs'))

const pinnedProxy = await buildTest('src/main/net/pinned-proxy.ts', 'out/test/pinned-proxy.mjs').then(() => import('../out/test/pinned-proxy.mjs'))

const atQuery = await buildTest('src/renderer/src/features/composer/at-query.ts', 'out/test/at-query.mjs', { platform: 'neutral' }).then(() => import('../out/test/at-query.mjs'))
const { runAtQueryTests } = await import('./test-at-query.mjs')

const fileListing = await buildTest('src/main/files.ts', 'out/test/files.mjs').then(() => import('../out/test/files.mjs'))
const { runFileListingTests } = await import('./test-files.mjs')
const { runFilesWatchTests } = await import('./test-files-watch.mjs')
const { runOpenGuardTests } = await import('./test-open-guard.mjs')
const { runRailSectionsTests } = await import('./test-rail-sections.mjs')
const { runRightPanelTests } = await import('./test-right-panel.mjs')

const railSections = await buildTest('src/renderer/src/features/workbench/rail-sections.ts', 'out/test/rail-sections.mjs').then(() => import('../out/test/rail-sections.mjs'))

const openGuard = await buildTest('src/main/open-guard.ts', 'out/test/open-guard.mjs').then(() => import('../out/test/open-guard.mjs'))

const filesWatch = await buildTest('src/main/files-watch.ts', 'out/test/files-watch.mjs').then(() => import('../out/test/files-watch.mjs'))

const fileContentSearch = await buildTest('src/main/file-content-search.ts', 'out/test/file-content-search.mjs').then(() => import('../out/test/file-content-search.mjs'))

const fileEditor = await buildTest('src/main/file-editor.ts', 'out/test/file-editor.mjs').then(() => import('../out/test/file-editor.mjs'))

const slashQuery = await buildTest('src/renderer/src/features/composer/slash-query.ts', 'out/test/slash-query.mjs', { platform: 'neutral' }).then(() => import('../out/test/slash-query.mjs'))
const { runSlashQueryTests } = await import('./test-slash-query.mjs')

const capabilityRequest = await buildTest('src/renderer/src/state/capability-request.ts', 'out/test/capability-request.mjs', { platform: 'neutral' }).then(() => import('../out/test/capability-request.mjs'))
const { runCapabilityRequestTests } = await import('./test-capability-request.mjs')

const compactionEvents = await buildTest('src/main/compaction.ts', 'out/test/compaction.mjs').then(() => import('../out/test/compaction.mjs'))
const compactionView = await buildTest('src/renderer/src/state/compaction-view.ts', 'out/test/compaction-view.mjs', { platform: 'neutral' }).then(() => import('../out/test/compaction-view.mjs'))

const stdioGuard = await buildTest('src/main/stdio-guard.ts', 'out/test/stdio-guard.mjs').then(() => import('../out/test/stdio-guard.mjs'))

const remoteServer = await buildTest('src/main/remote-server.ts', 'out/test/remote-server.mjs').then(() => import('../out/test/remote-server.mjs'))
const { runRemoteServerTests } = await import('./test-remote.mjs')
const peerDeps = await import('../node_modules/esbuild/lib/main.js').then(async ({ build }) => {
  const out = {}
  for (const [entry, name] of [['src/main/remote-devices.ts', 'remote-devices'], ['src/main/peer-grants.ts', 'peer-grants']]) {
    await buildTest(entry, `out/test/${name}.mjs`)
    Object.assign(out, await import(`../out/test/${name}.mjs`))
  }
  return out
})
const { runPeerTests } = await import('./test-peer.mjs')

const quotaCommandCode = await buildTest('src/main/quota-commandcode.ts', 'out/test/quota-commandcode.mjs', { platform: 'neutral' }).then(() => import('../out/test/quota-commandcode.mjs'))

const quotaTone = await buildTest('src/shared/quota-tone.ts', 'out/test/quota-tone.mjs', { platform: 'neutral' }).then(() => import('../out/test/quota-tone.mjs'))

await buildTest('src/main/normalize.ts', 'out/test/normalize.mjs', { platform: 'neutral' })
await buildTest('src/main/session-items/projector.ts', 'out/test/projector.mjs', { platform: 'neutral' })

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass++
    console.log(`✓ ${label}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`✗ ${label}${extra ? '  ' + extra : ''}`)
  }
}

console.log(`临时会话目录: ${dir}`)
console.log(`模块用的目录: ${SESSIONS_DIR}`)
ok(SESSIONS_DIR === dir, 'YAN_SESSIONS_DIR 生效（测试不会碰真实会话）')
ok(isolatedEnv, '测试环境已隔离（宿主 YAN_*/PI_* 已清空，数据目录在临时区）')

await guarded("runSessionConcurrencyConflictTests(ok)", () => runSessionConcurrencyConflictTests(ok))
await guarded("runSessionConcurrencyFrontendTests(ok)", () => runSessionConcurrencyFrontendTests(ok))
await guarded("runSessionStatsIsolationTests(ok)", () => runSessionStatsIsolationTests(ok))

await guarded("runSessionConcurrencySendGuardTests(ok)", () => runSessionConcurrencySendGuardTests(ok))
await guarded("runSessionConcurrencyFinalEdgesTests(ok)", () => runSessionConcurrencyFinalEdgesTests(ok))
await guarded("runCommandCodeQuotaDisplayTests(ok)", () => runCommandCodeQuotaDisplayTests(ok))
await guarded("runSubagentActiveVisibilityTests(ok)", () => runSubagentActiveVisibilityTests(ok))
await guarded("runSubagentParentOwnershipTests(ok)", () => runSubagentParentOwnershipTests(ok))

await guarded("runSessionSyncRaceTests(ok)", () => runSessionSyncRaceTests(ok))
await guarded("runHostOwnershipTests(ok)", () => runHostOwnershipTests(ok))
await guarded("runSnapshotIdentityTests(ok)", () => runSnapshotIdentityTests(ok))
await guarded("runExecutionAdmissionTests(ok)", () => runExecutionAdmissionTests(ok))
await guarded("runEpochSnapshotTests(ok)", () => runEpochSnapshotTests(ok))
await guarded("runAccountQuotaPaneTests(ok)", () => runAccountQuotaPaneTests(ok))

const PROJECT = join(dir, '--C--Users-Test--')
await mkdir(PROJECT, { recursive: true })

const line = (o) => JSON.stringify(o) + '\n'

async function makeSession(file, opts) {
  const p = join(PROJECT, file)
  let body = line({
    type: 'session',
    version: 3,
    id: opts.id,
    timestamp: opts.timestamp,
    cwd: opts.cwd,
    ...(opts.parentSession ? { parentSession: opts.parentSession } : {})
  })
  if (opts.name) {
    body += line({
      type: 'session_info',
      id: 'n1',
      parentId: null,
      timestamp: opts.timestamp,
      name: opts.name
    })
  }
  for (const text of opts.messages) {
    body += line({
      type: 'message',
      id: 'm' + Math.random().toString(36).slice(2, 8),
      parentId: null,
      timestamp: opts.timestamp,
      message: { role: 'user', content: [{ type: 'text', text }] }
    })
  }
  await writeFile(p, body, 'utf8')
  return p
}

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Test'

console.log('\n--- 1. 标题：优先 session_info 的名字 ---')

const pNamed = await makeSession('a.jsonl', {
  id: 'aaa',
  timestamp: new Date().toISOString(),
  cwd: 'C:\\Users\\Test\\proj',
  name: '季度总结',
  messages: ['这条应该被名字盖住']
})

const pUnnamed = await makeSession('b.jsonl', {
  id: 'bbb',
  timestamp: new Date().toISOString(),
  cwd: 'C:\\Users\\Test\\proj',
  messages: ['没名字的会话就用首条消息当标题']
})

let list = await listSessions()
const named = list.find((s) => s.id === 'aaa')
const unnamed = list.find((s) => s.id === 'bbb')

ok(!!named && named.title === '季度总结', '有 session_info 时用名字', `title=${named?.title}`)
ok(!!named && named.named === true, 'named 标记为 true')
ok(!!unnamed && unnamed.title === '没名字的会话就用首条消息当标题', '没有名字时用首条用户消息')
ok(!!unnamed && unnamed.named === false, 'named 标记为 false')
ok(list.length === 2, `列出 ${list.length} 个会话`)

console.log('\n--- 1b. 按需标题只取首条 / 最近用户文字 ---')

const pSamples = await makeSession('samples.jsonl', {
  id: 'samples',
  timestamp: new Date().toISOString(),
  cwd: 'C:\\Users\\Test\\proj',
  messages: ['首条用户意图', '中间消息', '最近的用户问题']
})
const titleSamples = await readTitleSamples(pSamples)
ok(titleSamples.length === 2, '标题样本只有首条和最近一条', JSON.stringify(titleSamples))
ok(titleSamples[0] === '首条用户意图' && titleSamples[1] === '最近的用户问题', '标题样本保持时间顺序')

const pLongSamples = await makeSession('samples-long.jsonl', {
  id: 'samples-long',
  timestamp: new Date().toISOString(),
  cwd: 'C:\\Users\\Test\\proj',
  messages: ['A'.repeat(800), 'B'.repeat(800)]
})
const longTitleSamples = await readTitleSamples(pLongSamples)
ok(longTitleSamples.every((sample) => sample.length <= 600), '每条标题样本最多 600 字符')
ok(longTitleSamples.reduce((n, sample) => n + sample.length, 0) <= 1200, '标题样本总量最多 1200 字符')

console.log('\n--- 2. 名字取最后一个（改名后应生效）---')

const pRename = join(PROJECT, 'a.jsonl')
const renamed = await import('node:fs/promises').then((fs) => fs.readFile(pRename, 'utf8'))
await writeFile(
  pRename,
  renamed +
    line({
      type: 'session_info',
      id: 'n2',
      parentId: 'n1',
      timestamp: new Date().toISOString(),
      name: '季度总结 · 定稿'
    }),
  'utf8'
)

list = await listSessions()
const afterRename = list.find((s) => s.id === 'aaa')
ok(
  afterRename?.title === '季度总结 · 定稿',
  '名字改了之后列出的是新名字',
  `title=${afterRename?.title}`
)

console.log('\n--- 3. 家目录缩成 ~ ---')

const pPath = await makeSession('c.jsonl', {
  id: 'ccc',
  timestamp: new Date().toISOString(),
  cwd: HOME,
  messages: [`${HOME}\\Desktop\\pi-desktop 读这个文件`]
})

list = await listSessions()
const shortened = list.find((s) => s.id === 'ccc')
ok(
  shortened?.title.startsWith('~'),
  '标题里的家目录被缩成 ~',
  `title=${shortened?.title}`
)
ok(shortened?.title.length <= 35, `标题被截断到 ${shortened?.title.length} 字符（上限 34+省略号）`)

console.log('\n--- 4. cwd 取自 session 头 ---')
ok(shortened?.cwd === HOME, 'cwd 解析正确', `cwd=${shortened?.cwd}`)

console.log('\n--- 5. 消息条数 ---')
ok(shortened?.messageCount === 1, 'messageCount = 1', `实际 ${shortened?.messageCount}`)

console.log('\n--- 6. 按更新时间倒序 ---')
const times = list.map((s) => s.updatedAt)
ok(
  times.every((v, i) => i === 0 || times[i - 1] >= v),
  '列表按 updatedAt 倒序',
  times.join(' ≥ ')
)

console.log('\n--- 8. 删除的路径防护 ---')

const branchRoot = await makeSession('branch-root.jsonl', {
  id: 'branch-root', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['root']
})
const branchChild = await makeSession('branch-child.jsonl', {
  id: 'branch-child', parentSession: 'branch-root', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['child']
})
const branchGrandchild = await makeSession('branch-grandchild.jsonl', {
  id: 'branch-grandchild', parentSession: 'branch-child', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['grandchild']
})
const branchToken = await deleteSession(branchRoot, branchGrandchild)
const afterBranchDelete = await listSessions()
ok(!afterBranchDelete.some((s) => s.path === branchRoot), '删除父会话只移除父会话本身')
ok([branchChild, branchGrandchild].every((p) => afterBranchDelete.some((s) => s.path === p)), '删除父会话保留分支会话')
await restoreSession(branchToken)
const afterBranchRestore = await listSessions()
ok([branchRoot, branchChild, branchGrandchild].every((p) => afterBranchRestore.some((s) => s.path === p)), '撤销删除恢复父会话')

let protectedRejected = false
try { await deleteSession(branchGrandchild, branchGrandchild) } catch { protectedRejected = true }
ok(protectedRejected, '拒绝删除当前正在使用的会话')
const afterProtected = await listSessions()
ok([branchRoot, branchChild, branchGrandchild].every((p) => afterProtected.some((s) => s.path === p)), '拒绝删除时不会移动任何会话文件')

await writeFile(`${pPath}.history.txt`, '=== compaction 1 ===\n')
const undoToken = await deleteSession(pPath)
list = await listSessions()
ok(!list.some((s) => s.id === 'ccc'), '删除后列表里没有了')
ok(!existsSync(`${pPath}.history.txt`), '压缩原文快照随会话一起移进回收站')
await restoreSession(undoToken)
list = await listSessions()
ok(list.some((s) => s.id === 'ccc'), '撤销后会话恢复到原路径')
ok(existsSync(`${pPath}.history.txt`), '撤销删除时快照也恢复')

let rejected = false
try {
  await deleteSession(join(dir, '..', '..', 'evil.jsonl'))
} catch {
  rejected = true
}
ok(rejected, '拒绝删除会话目录之外的文件')

rejected = false
try {
  await deleteSession(join(PROJECT, 'a.txt'))
} catch {
  rejected = true
}
ok(rejected, '拒绝删除非 .jsonl 文件')

console.log('\n--- 9. 坏数据不致命 ---')

await writeFile(join(PROJECT, 'broken.jsonl'), 'not json at all\n{{{', 'utf8')
await writeFile(join(PROJECT, 'empty.jsonl'), '', 'utf8')

const survived = await listSessions()
ok(Array.isArray(survived), '遇到坏文件仍返回数组', `${survived.length} 条`)
ok(
  survived.some((s) => s.id === 'aaa'),
  '正常会话不受影响'
)

console.log('\n--- 10. 不存在的目录 ---')
await rm(dir, { recursive: true, force: true })
process.env.YAN_SESSIONS_DIR = join(dir, 'nope')
const empty = await listSessions()
ok(Array.isArray(empty), '目录被删后仍返回数组', `${empty.length} 条`)

console.log('\n--- 11. pi 定位：来源分类 ---')
const { resolvePi, bundledAvailable, piInfo, resetPiVersionCache } = await import('../out/main/protocol.js')

const piTmp = await mkdtemp(join(tmpdir(), 'yan-pi-'))
const fakeCli = join(piTmp, 'fake-cli.js')
await writeFile(fakeCli, '// stub\n', 'utf8')

process.env.YAN_PI_BIN = fakeCli
const envProbe = resolvePi()
ok(envProbe.source === 'env', 'YAN_PI_BIN 命中时来源 = env', `source=${envProbe.source}`)
ok(envProbe.args.includes(fakeCli), 'env 命中时参数指向该入口')

const ovProbe = resolvePi({ override: fakeCli })
ok(ovProbe.source === 'override', 'piBin 优先于 YAN_PI_BIN', `source=${ovProbe.source}`)
ok(ovProbe.home === undefined || typeof ovProbe.home === 'string', 'home 字段类型正确')

delete process.env.YAN_PI_BIN

resetPiVersionCache()
const piInfoRes = await piInfo(fakeCli, { fresh: true })
ok(piInfoRes.source === 'override', 'piInfo 透传来源', `source=${piInfoRes.source}`)
ok(piInfoRes.bin === fakeCli, 'piInfo.bin 为指定入口')
ok(typeof piInfoRes.bundledAvailable === 'boolean', 'piInfo.bundledAvailable 是布尔')

await rm(piTmp, { recursive: true, force: true })

await guarded("runTurnTests(ok)", () => runTurnTests(ok))
await guarded("runTurnTimingTests(ok)", () => runTurnTimingTests(ok))
await guarded("runDurationTests(ok)", () => runDurationTests(ok))
await guarded("runTurnTimingStoreTests(ok)", () => runTurnTimingStoreTests(ok))

await guarded("runZoomTests(ok)", () => runZoomTests(ok))

await guarded("runFileRefTests(ok)", () => runFileRefTests(ok))

await guarded("runLinkTests(ok)", () => runLinkTests(ok))
await guarded("runFileResourceTests(ok)", () => runFileResourceTests(ok))

const { runFileUrlTests } = await import('./test-file-url.mjs')
await guarded("runFileUrlTests(ok)", () => runFileUrlTests(ok))

const { runSessionSwitchTests } = await import('./test-session-switch.mjs')
await guarded("runSessionSwitchTests(ok)", () => runSessionSwitchTests(ok))

await guarded("runWorkbenchTests(ok)", () => runWorkbenchTests(ok))

await guarded("runBrowserVisibilityTests(ok)", () => runBrowserVisibilityTests(ok))

await guarded("runBrowserNavigationTests(ok)", () => runBrowserNavigationTests(ok))

await guarded("runSubagentViewTests(ok)", () => runSubagentViewTests(ok))

await guarded("runSubagentUsageTests(ok)", () => runSubagentUsageTests(ok))

await guarded("runKeepImagesTests(ok)", () => runKeepImagesTests(ok))
await guarded("runSameMessagesTests(ok)", () => runSameMessagesTests(ok))
await guarded("runStableRefTests(ok)", () => runStableRefTests(ok))
await guarded("runAttachmentTests(ok)", () => runAttachmentTests(ok))
await guarded("runSessionImageTests(ok)", () => runSessionImageTests(ok))
const { runImageStoreTests } = await import('./test-image-store.mjs')
await guarded("runImageStoreTests(ok)", () => runImageStoreTests(ok))

await guarded("runResponseDetailTests(ok)", () => runResponseDetailTests(ok))

await guarded("runSnapshotTests(ok)", () => runSnapshotTests(ok))

await guarded("runChromeProfileTests(ok)", () => runChromeProfileTests(ok))

await guarded("runQuestionTests(ok)", () => runQuestionTests(ok))

await guarded("runRepeatGuardTests(ok)", () => runRepeatGuardTests(ok))

await buildTest('src/shared/session-chain.ts', 'out/test/session-chain.mjs', { platform: 'neutral' })
await buildTest('src/main/session-chain-service.ts', 'out/test/session-chain-service.mjs')
const { runSessionChainTests } = await import('./test-session-chain.mjs')
await guarded("runSessionChainTests(ok)", () => runSessionChainTests(ok))
await buildTest('src/main/session-history.ts', 'out/test/session-history.mjs')
const { runSessionHistoryTests } = await import('./test-session-history.mjs')
await runSessionHistoryTests(
  ok,
  await import('../out/test/session-history.mjs'),
  await import('../out/test/session-chain-service.mjs')
)

await buildTest('src/shared/model-errors.ts', 'out/test/model-errors.mjs', { platform: 'neutral' })
const { runModelErrorTests } = await import('./test-model-errors.mjs')
await guarded("runModelErrorTests(ok)", () => runModelErrorTests(ok))

await buildTest('src/shared/quota-resume.ts', 'out/test/quota-resume.mjs', { platform: 'neutral' })
const { runQuotaResumeTests } = await import('./test-quota.mjs')
await guarded("runQuotaResumeTests(ok)", () => runQuotaResumeTests(ok))
await guarded("runTodoHistoryTests(ok)", () => runTodoHistoryTests(ok))
await guarded("runTaskPlanTests(ok)", () => runTaskPlanTests(ok))
await guarded("runTaskPlanStoreTests(ok)", () => runTaskPlanStoreTests(ok))
await runCapabilityCatalogTests(ok, {
  capabilities: capabilityCatalogShared,
  skill: capabilitySkillService,
  catalog: capabilityCatalogMain
})

await guarded("runDiscoveryTests(ok, { shared: discoveryShared, discover: d", () => runDiscoveryTests(ok, { shared: discoveryShared, discover: discoveryMain }))
await runAcquisitionTests(ok, {
  shared: acquisitionShared,
  service: acquisitionService,
  npmArtifact,
  npmAcquisition,
  packageAuthorizationShared,
  packageAuthorizationService
})
await guarded("runSkillSecurityTests(ok, skillSecurity)", () => runSkillSecurityTests(ok, skillSecurity))
await runPiPackageSchedulerTests(ok, {
  AcquisitionService: acquisitionService.AcquisitionService,
  PiPackageActivationScheduler: piPackageScheduler.PiPackageActivationScheduler
})
await guarded("runPiPackageSmokeTests(ok, piPackageSmoke)", () => runPiPackageSmokeTests(ok, piPackageSmoke))
await runMcpTests(ok, {
  mcp: mcpShared,
  config: mcpConfig,
  manager: mcpManager,
  toolService: mcpToolService
})
await guarded("runExtensionInventoryTests(ok)", () => runExtensionInventoryTests(ok))

await guarded("runSubagentIsolationTests(ok, subagentIsolation)", () => runSubagentIsolationTests(ok, subagentIsolation))

await guarded("runSubagentControllerTests(ok, SubagentController)", () => runSubagentControllerTests(ok, SubagentController))

runProjectIdTests(ok, projectId)

runProjectSessionTests(ok, projectSession)

const workspaceChanges = await buildTest('src/main/snapshots.ts', 'out/test/snapshots.mjs').then(() => import('../out/test/snapshots.mjs'))
const { runWorkspaceChangesTests, runGitWorkspaceChangesTests } = await import('./test-workspace-changes.mjs')
await guarded("runWorkspaceChangesTests(ok, workspaceChanges)", () => runWorkspaceChangesTests(ok, workspaceChanges))
await guarded("runGitWorkspaceChangesTests(ok, workspaceChanges)", () => runGitWorkspaceChangesTests(ok, workspaceChanges))

{
  const { runPushRoutingTests } = await import('./test-push-routing.mjs')
  runPushRoutingTests(ok, pushRouting)
}

{
  const { runModelPricingTests } = await import('./test-model-pricing.mjs')
  await runModelPricingTests(ok)
}

{
  const { runSplitViewTests } = await import('./test-split-view.mjs')
  await runSplitViewTests(ok)
}

await guarded("import('./test-split-drop-model.mjs')", () => import('./test-split-drop-model.mjs'))
await guarded("import('./test-v3-side-by-side.mjs')", () => import('./test-v3-side-by-side.mjs'))
await guarded("import('./test-v3-side-by-side-resize.mjs')", () => import('./test-v3-side-by-side-resize.mjs'))

{
  const { runRemoteApprovalTests } = await import('./test-remote-approval.mjs')
  await runRemoteApprovalTests(ok)
}

{
  const { runKeepAwakeTests } = await import('./test-keep-awake.mjs')
  await runKeepAwakeTests(ok)
}

{
  const { runSessionArchiveTests } = await import('./test-session-archive.mjs')
  await runSessionArchiveTests(ok)
}

{
  const { runSessionMoveTests } = await import('./test-session-move.mjs')
  await runSessionMoveTests(ok)
}

{
  const { runSessionLayoutTests } = await import('./test-session-layout.mjs')
  await runSessionLayoutTests(ok, sessionLayout)
}

{
  const { runExitSnapshotTests } = await import('./test-exit-snapshot.mjs')
  await runExitSnapshotTests(ok, exitSnapshot)
}

{
  const { runCommandRegistryTests } = await import('./test-command-registry.mjs')
  runCommandRegistryTests(ok, commandRegistry)
}

{
  const { runModelCapabilitiesTests } = await import('./test-model-capabilities.mjs')
  runModelCapabilitiesTests(ok, modelCapabilities)
}

{
  const { runBuildInfoTests } = await import('./test-build-info.mjs')
  runBuildInfoTests(ok, buildInfo)
}

{
  const { runNetworkPolicyTests } = await import('./test-network-policy.mjs')
  await runNetworkPolicyTests(ok, networkPolicy)
}

{
  const { runManualTitleTests } = await import('./test-manual-title.mjs')
  await runManualTitleTests(ok, manualTitle, dataDir)
}

{
  const { runNetworkBoundaryTests } = await import('./test-network-boundary.mjs')
  await runNetworkBoundaryTests(ok, networkBoundary)
}

{
  const { runPinnedResolverTests, runPinnedProxyTests } = await import('./test-pinned-network.mjs')
  await runPinnedResolverTests(ok, pinnedResolver)
  await runPinnedProxyTests(ok, pinnedProxy)
}

{
  const { runHiddenPageTests } = await import('./test-hidden-page.mjs')
  await runHiddenPageTests(ok)
}

{
  const { runSearchLookupTests } = await import('./test-search-lookup.mjs')
  await runSearchLookupTests(ok)
}

{
  const { runPromptSkillContractTests } = await import('./test-prompt-skill-contracts.mjs')
  await runPromptSkillContractTests(ok)
}

runAtQueryTests(ok, atQuery)
{
  const { runQuotaCommandCodeTests, runQuotaToneTests } = await import('./test-quota.mjs')
  runQuotaCommandCodeTests(ok, quotaCommandCode)
  runQuotaToneTests(ok, quotaTone)
}
runSlashQueryTests(ok, slashQuery)
runCapabilityRequestTests(ok, capabilityRequest)
await guarded("runFileListingTests(ok, fileListing)", () => runFileListingTests(ok, fileListing))
await guarded("runFilesWatchTests(ok, filesWatch)", () => runFilesWatchTests(ok, filesWatch))
await guarded("runOpenGuardTests(ok, openGuard)", () => runOpenGuardTests(ok, openGuard))
await guarded("runRailSectionsTests(ok, railSections)", () => runRailSectionsTests(ok, railSections))
await guarded("runRightPanelTests(ok)", () => runRightPanelTests(ok))
await guarded("runFileContentSearchTests(ok, fileContentSearch)", () => runFileContentSearchTests(ok, fileContentSearch))
await guarded("runFileEditorTests(ok, fileEditor)", () => runFileEditorTests(ok, fileEditor))

const { runCredentialsTests } = await import('./test-credentials.mjs')
await guarded("runCredentialsTests(ok)", () => runCredentialsTests(ok))

const { runApiKeyPoolTests } = await import('./test-api-key-pool.mjs')
await guarded("runApiKeyPoolTests(ok)", () => runApiKeyPoolTests(ok))
const { runOAuthAccountTests } = await import('./test-oauth-accounts.mjs')
await guarded("runOAuthAccountTests(ok)", () => runOAuthAccountTests(ok))

const { runSettingsStoreTests } = await import('./test-settings-store.mjs')
await guarded("runSettingsStoreTests(ok)", () => runSettingsStoreTests(ok))

const { runOAuthTests } = await import('./test-oauth.mjs')
await guarded("runOAuthTests(ok)", () => runOAuthTests(ok))

const { runStreamDeltasTests } = await import('./test-stream-deltas.mjs')
await guarded("runStreamDeltasTests(ok)", () => runStreamDeltasTests(ok))

const titleSampleMod = await buildTest('src/shared/title-samples.ts', 'out/test/title-samples.mjs', { platform: 'neutral' }).then(() => import('../out/test/title-samples.mjs'))
const { runTitleSampleTests } = await import('./test-title-samples.mjs')
runTitleSampleTests(ok, titleSampleMod)

const { runCompactionStatusTests } = await import('./test-compaction-status.mjs')
runCompactionStatusTests(ok, compactionEvents, compactionView)

const { runStdioGuardTests } = await import('./test-stdio-guard.mjs')
runStdioGuardTests(ok, stdioGuard)

await guarded("runRemoteServerTests(ok, remoteServer)", () => runRemoteServerTests(ok, remoteServer))
await guarded("runPeerTests(ok, { ...remoteServer, ...peerDeps })", () => runPeerTests(ok, { ...remoteServer, ...peerDeps }))
const { runRemoteDeviceTests } = await import('./test-remote-devices.mjs')
await guarded("runRemoteDeviceTests(ok, peerDeps)", () => runRemoteDeviceTests(ok, peerDeps))

const languageExtension = await import('../resources/pi-extensions/language.js')
const { runLanguageExtensionTests } = await import('./test-language-extension.mjs')
await guarded("runLanguageExtensionTests(ok, languageExtension)", () => runLanguageExtensionTests(ok, languageExtension))

const preambleExtension = await import('../resources/pi-extensions/preamble.js')
const { runPreambleExtensionTests } = await import('./test-preamble-extension.mjs')
await guarded("runPreambleExtensionTests(ok, preambleExtension)", () => runPreambleExtensionTests(ok, preambleExtension))
{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await buildTest('src/shared/context-limits.ts', 'out/test/context-limits.mjs')
  const autoCompact = await import('../resources/pi-extensions/auto-compact.js')
  const contextLimits = await import('../out/test/context-limits.mjs')
  const { runAutoCompactTests } = await import('./test-auto-compact.mjs')
  await runAutoCompactTests(ok, autoCompact, contextLimits)
}
const { runAppUpdateTests } = await import('./test-app-update.mjs')
await guarded("runAppUpdateTests(ok)", () => runAppUpdateTests(ok))

const ipcError = await buildTest('src/shared/ipc-error.ts', 'out/test/ipc-error.mjs', { platform: 'neutral' }).then(() => import('../out/test/ipc-error.mjs'))
const { runIpcErrorTests } = await import('./test-ipc-error.mjs')
await guarded("runIpcErrorTests(ok, ipcError)", () => runIpcErrorTests(ok, ipcError))


const quotaMini = await buildTest('src/shared/quota-mini.ts', 'out/test/quota-mini.mjs', { platform: 'neutral' }).then(() => import('../out/test/quota-mini.mjs'))
const { runQuotaMiniTests } = await import('./test-quota.mjs')
await guarded("runQuotaMiniTests(ok, quotaMini)", () => runQuotaMiniTests(ok, quotaMini))

const runProgress = await buildTest('src/shared/run-progress.ts', 'out/test/run-progress.mjs', { platform: 'neutral' }).then(() => import('../out/test/run-progress.mjs'))
const { runRunProgressTests } = await import('./test-run-progress.mjs')
await guarded("runRunProgressTests(ok, runProgress)", () => runRunProgressTests(ok, runProgress))

const customProvider = await buildTest('src/shared/custom-provider.ts', 'out/test/custom-provider.mjs', { platform: 'neutral' }).then(() => import('../out/test/custom-provider.mjs'))
const { runCustomProviderTests } = await import('./test-custom-provider.mjs')
await guarded("runCustomProviderTests(ok, customProvider)", () => runCustomProviderTests(ok, customProvider))

const gitState = await buildTest('src/shared/git.ts', 'out/test/git.mjs', { platform: 'neutral' }).then(() => import('../out/test/git.mjs'))
const { runGitStateTests } = await import('./test-git-lib.mjs')
await guarded("runGitStateTests(ok, gitState)", () => runGitStateTests(ok, gitState))

const gitActions = await buildTest('src/shared/git-actions.ts', 'out/test/git-actions.mjs', { platform: 'neutral', logLevel: 'warning' }).then(() => import('../out/test/git-actions.mjs'))
const { runGitActionTests } = await import('./test-git-lib.mjs')
await guarded("runGitActionTests(ok)", () => runGitActionTests(ok))

await Promise.all([
    buildTest('src/main/git-service.ts', 'out/test/git-service.mjs'),
    buildTest('src/main/git-actions.ts', 'out/test/git-actions-main.mjs', { logLevel: 'warning' }),
    buildTest('src/main/git-worktree.ts', 'out/test/git-worktree.mjs', { logLevel: 'warning' }),
    buildTest('src/main/sources.ts', 'out/test/sources.mjs', { logLevel: 'warning' }),
    buildTest('src/main/worktree-links.ts', 'out/test/worktree-links.mjs', { logLevel: 'warning' }),
    buildTest('src/main/session-isolation.ts', 'out/test/session-isolation.mjs', { logLevel: 'warning' }),
    buildTest('src/main/question-log.ts', 'out/test/question-log-store.mjs', { logLevel: 'warning' }),
    buildTest('src/shared/question-log.ts', 'out/test/question-log.mjs', { platform: 'neutral', logLevel: 'warning' }),
    buildTest('src/main/packages.ts', 'out/test/packages.mjs', { logLevel: 'warning' })
  ])
const { runGitRepoTests } = await import('./test-git-lib.mjs')
const { runPackagesTests } = await import('./test-packages.mjs')
const { runSourcesTests } = await import('./test-sources.mjs')
const { runWorktreeLinkTests } = await import('./test-worktree-links.mjs')
const { runSessionIsolationTests } = await import('./test-session-isolation.mjs')
const { runQuestionLogTests } = await import('./test-question-log.mjs')
console.log('\n--- 宿主提问：回放合并 + 按会话落盘 ---')
await guarded("runQuestionLogTests(ok)", () => runQuestionLogTests(ok))
console.log('\n--- P2. pi 包管理（真实 pi CLI，隔离 agent 目录）---')
const piCliPath = join(selectedPiRuntime(join('resources', 'pi-runtime')), 'dist', 'bundle', 'cli.js')
if (!existsSync(piCliPath)) throw new Error(`内置 pi CLI 不在（${piCliPath}）：先跑 npm run vendor:pi`)
await guarded("runPackagesTests(ok)", () => runPackagesTests(ok))
const { runPluginMarketTests } = await import('./test-plugin-market.mjs')
await guarded("runPluginMarketTests(ok)", () => runPluginMarketTests(ok))
const { runVisualBlockTests } = await import('./test-visual-blocks.mjs')
await guarded("runVisualBlockTests(ok)", () => runVisualBlockTests(ok))
const { runAppearanceTests } = await import('./test-appearance.mjs')
console.log('\n--- 外观个性化：字体、字号与背景色 ---')
await guarded("runAppearanceTests(ok)", () => runAppearanceTests(ok))
const { runUsageStatsTests } = await import('./test-usage-stats.mjs')
console.log('\n--- 启动页用量概览：按行计数与范围聚合 ---')
await guarded("runUsageStatsTests(ok)", () => runUsageStatsTests(ok))
console.log('\n--- S1. 会话来源的持久化引用 ---')
await guarded("runSourcesTests(ok)", () => runSourcesTests(ok))
console.log('\n--- S2. 会话↔工作树来源关系（实施-07）---')
await guarded("runWorktreeLinkTests(ok)", () => runWorktreeLinkTests(ok))
console.log('\n--- S2b. 同一工作目录冲突 → 自动隔离与自动合回 ---')
await guarded("runSessionIsolationTests(ok)", () => runSessionIsolationTests(ok))
await guarded("runGitRepoTests(ok)", () => runGitRepoTests(ok))

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await buildTest('src/main/capability-server.ts', 'out/test/capability-server.mjs')
  const { CapabilityServer, CAPABILITY_API_VERSION } = await import(
    '../out/test/capability-server.mjs'
  )
  const { readFile } = await import('node:fs/promises')
  const opsDir = await mkdtemp(join(tmpdir(), 'yan-ops-'))

  const server = new CapabilityServer({ opsDir })
  const { url, token } = await server.start({ sessionId: 's-1', projectId: 'p-1' })

  const call = async (body, headers = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...headers
      },
      body: JSON.stringify({ apiVersion: CAPABILITY_API_VERSION, ...body })
    })
    return { status: res.status, body: await res.json() }
  }
  const me = { sessionId: 's-1', projectId: 'p-1' }

  const good = await call({ ...me, command: 'operations.status', params: { limit: 5 } })
  ok(good.status === 200 && good.body.ok === true, '能力服务：合法请求返回 ok', JSON.stringify(good.body).slice(0, 140))
  ok(typeof good.body.resultFile === 'string', '能力服务：大结果落文件并回路径', String(good.body.resultFile))
  ok(!('data' in good.body), '能力服务：响应只回摘要，不回完整数据', Object.keys(good.body ?? {}).join(','))
  if (typeof good.body.resultFile === 'string') {
    const text = await readFile(good.body.resultFile, 'utf8')
    ok(text.includes('"ops"'), '能力服务：结果文件是结构化 JSON', text.slice(0, 60))
  }

  const forged = await call({ sessionId: 's-1', projectId: 'p-2', command: 'operations.status' })
  ok(
    forged.status === 403 && forged.body.error === 'identity_mismatch',
    '能力服务：伪造 projectId 被拒',
    JSON.stringify(forged.body)
  )
  const forgedSession = await call({ sessionId: 's-9', projectId: 'p-1', command: 'operations.status' })
  ok(forgedSession.status === 403, '能力服务：伪造 sessionId 同样被拒', JSON.stringify(forgedSession.body))

  const badToken = await call({ ...me, command: 'operations.status' }, { authorization: 'Bearer wrong' })
  ok(badToken.status === 401, '能力服务：错误 token 被拒', JSON.stringify(badToken.body))

  const unknown = await call({ ...me, command: 'evil.exfiltrate' })
  ok(
    unknown.status === 400 && unknown.body.error === 'unknown_command',
    '能力服务：未登记命令被拒',
    JSON.stringify(unknown.body)
  )

  const notImpl = await call({ ...me, command: 'skill.read' })
  ok(
    notImpl.status === 200 && notImpl.body.ok === false && /not_implemented/.test(String(notImpl.body.error)),
    '能力服务：未实现命令走完整管道后如实报错',
    JSON.stringify(notImpl.body)
  )

  const subagentRegistered = await call({ ...me, command: 'subagent.list' })
  ok(
    subagentRegistered.status === 200 && subagentRegistered.body.error !== 'unknown_command',
    '能力服务：子代理命令已登记进宿主入口',
    JSON.stringify(subagentRegistered.body)
  )

  const badVersion = await call({ ...me, command: 'operations.status', apiVersion: 999 })
  ok(badVersion.status === 400, '能力服务：协议版本不一致被拒', JSON.stringify(badVersion.body))

  server.stop()
  const afterStop = await call({ ...me, command: 'operations.status' }).catch(() => null)
  ok(afterStop === null || afterStop.status >= 400, '能力服务：stop 后端点不再服务')

  await rm(opsDir, { recursive: true, force: true })
}

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await buildTest('src/main/yan-cli.ts', 'out/test/yan-cli.mjs')
  const { ensureYanLauncher, resolveYanCli } = await import('../out/test/yan-cli.mjs')
  const { readFileSync } = await import('node:fs')
  const binDir = await mkdtemp(join(tmpdir(), 'yan-bin-'))

  ok(!!resolveYanCli({ devResourcesDir: 'resources' }), 'yan CLI：开发态能找到 resources/yan-cli/yan.mjs')

  const made = ensureYanLauncher({
    devResourcesDir: 'resources',
    execPath: 'C:/fake/electron.exe',
    binDir
  })
  ok(!!made, 'yan 启动器：能生成')
  if (made) {
    const text = readFileSync(made.launcher, 'utf8')
    ok(text.includes('ELECTRON_RUN_AS_NODE=1'), 'yan 启动器：以纯 Node 模式跑内置运行时')
    ok(text.includes('yan.mjs'), 'yan 启动器：指向随包 CLI 脚本')
    ok(text.includes('C:/fake/electron.exe'), 'yan 启动器：用的是应用自带运行时，不是用户的 node')
  }

  const missing = ensureYanLauncher({
    devResourcesDir: 'resources/does-not-exist',
    execPath: 'x',
    binDir
  })
  ok(missing === null, 'yan 启动器：找不到 CLI 时返回 null，不静默生成坏启动器')

  const { spawnSync } = await import('node:child_process')
  const syntax = spawnSync(process.execPath, ['--check', 'resources/yan-cli/yan.mjs'], { encoding: 'utf8' })
  ok(syntax.status === 0, 'yan CLI：语法可解析（node --check）', (syntax.stderr ?? '').split('\n')[0])
  const help = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', '--help'], { encoding: 'utf8' })
  ok(help.status === 0, 'yan CLI：--help 真的能跑（退出码 0）', (help.stderr ?? '').split('\n')[0])
  const capabilityHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'capabilities', '--help'], { encoding: 'utf8' })
  ok(
    /你不能替用户批准/.test(capabilityHelp.stdout ?? '') &&
      /逐文件核对 Git 哈希/.test(capabilityHelp.stdout ?? ''),
    'yan CLI：能力接入帮助写明模型不能替用户批准，GitHub 技能固定到提交并逐文件核对哈希'
  )

  await rm(binDir, { recursive: true, force: true })
}

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await buildTest('resources/pi-extensions/capability-guide.js', 'out/test/capability-guide.mjs')
  const mod = await import('../out/test/capability-guide.mjs')
  const guide = mod.CAPABILITY_GUIDE

  ok(!/data, not instructions/.test(guide) && !/When the user asks for something to be done/.test(guide), '能力说明不再重复工作方式与「工具结果是数据」（已移到 preamble 的 inkstone_work）')
  ok(!mod.capabilityGuide(true, { codemode: false }).includes('codemode') && mod.capabilityGuide(true).includes('codemode'), '能力说明：codemode 关闭时不提 codemode')
  ok(!/short plain prose|no headings or long lists/.test(mod.VISUAL_ANSWER_GUIDE), '可视化说明不再要求只写散文、不用列表')
  {
    const day = new Date(2026, 9, 19, 23, 30)
    const win = mod.environmentGuide(day, 'win32', undefined)
    ok(/Today: 2026-10-19/.test(win) && /Git Bash/.test(win) && /do not prefix commands with a cd/.test(win), '环境说明：本地日期、Windows 走 Git Bash、命令已在工作目录启动')
    ok(/PowerShell/.test(mod.environmentGuide(day, 'win32', 'powershell')) && !/Git Bash/.test(mod.environmentGuide(day, 'win32', 'powershell')), '环境说明：没有 Git Bash 时写 PowerShell')
    ok(/OS: macOS\./.test(mod.environmentGuide(day, 'darwin')), '环境说明：其他系统只写系统名')
  }
  {
    const hooks = {}
    mod.default({ on: (name, fn) => { (hooks[name] ??= []).push(fn) } })
    ok(!hooks.before_provider_request && !hooks.message_end && !hooks.tool_result, '能力扩展只写系统提示分区，不在请求末尾追加待办或收尾提醒')
  }
  const visual = mod.VISUAL_ANSWER_GUIDE
  const grammarModel = { model: { compat: { supportsOpenAIGrammarTools: true } } }
  {
    const probeHandlers = {}
    mod.default({ on: (name, fn) => { probeHandlers[name] = fn } })
    const options = { sections: { preamble: 'x' } }
    const result = probeHandlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: options }, grammarModel)
    ok(options.sections.inkstone_visual_answer === visual && options.sections.inkstone_capabilities === mod.CAPABILITY_GUIDE && result === undefined,
      '能力说明：有具名分区时只写分区、不返回整段提示（否则 pi 会固定整段提示，其他扩展的分区失效）')
    const plain = { sections: {} }
    probeHandlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: plain }, { model: { compat: {} } })
    ok(plain.sections.inkstone_capabilities === mod.capabilityGuide(false, { codemode: false }), '能力说明：自动模式下不支持语法工具的模型不提 codemode')
  }

  const handlers = {}
  mod.default({
    on: (name, fn) => {
      handlers[name] = fn
    }
  })
  ok(typeof handlers.before_agent_start === 'function', '能力说明：注册在 before_agent_start')

  const first = handlers.before_agent_start({ systemPrompt: 'base' }, grammarModel)
  ok(
    !!first && first.systemPrompt.startsWith('base') && first.systemPrompt.includes(mod.CAPABILITY_GUIDE),
    '能力说明：追加在系统提示末尾（不篡改原有内容）'
  )
  const second = handlers.before_agent_start({ systemPrompt: first.systemPrompt }, grammarModel)
  ok(second === undefined, '能力说明：幂等，已注入后不再重复追加')
}

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await buildTest('resources/pi-extensions/danger-guard.js', 'out/test/danger-guard.mjs')
  const dangerGuard = await import('../out/test/danger-guard.mjs')
  const { runDangerGuardTests, runApprovalBindingTests } = await import('./test-danger-guard.mjs')
  runDangerGuardTests(ok, dangerGuard)
  await runApprovalBindingTests(ok, dangerGuard)
}

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await buildTest('src/shared/session-search-text.ts', 'out/test/session-search-text.mjs')
  const searchText = await import('../out/test/session-search-text.mjs')
  const { runSessionSearchTests } = await import('./test-session-search.mjs')
  runSessionSearchTests(ok, searchText)
  const { runSessionSearchCacheTests } = await import('./test-session-search-cache.mjs')
  await runSessionSearchCacheTests(ok)
}

{
  await buildTest('src/shared/ui-timeout.ts', 'out/test/ui-timeout.mjs', { platform: 'neutral' })
  const { runUiTimeoutTests } = await import('./test-ui-timeout.mjs')
  await runUiTimeoutTests(ok)
}

{
  const { spawnSync } = await import('node:child_process')
  const { build } = await import('../node_modules/esbuild/lib/main.js')

  console.log('\n--- 01-S4b 浏览器 CLI ---')

  await buildTest('src/main/capability-server.ts', 'out/test/capability-server-browser.mjs')
  const { CapabilityServer, CAPABILITY_API_VERSION } = await import(
    '../out/test/capability-server-browser.mjs'
  )
  const opsDir = await mkdtemp(join(tmpdir(), 'yan-browser-ops-'))
  const seen = []
  const server = new CapabilityServer({
    opsDir,
    handlers: {
      run: async (command, params) => {
        seen.push(command)
        return { data: { command, params }, summary: { kind: 'browser', action: command.slice(8), ok: true } }
      }
    }
  })
  const { url, token } = await server.start({ sessionId: 's-b', projectId: 'p-b' })
  const call = async (command, params = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        apiVersion: CAPABILITY_API_VERSION,
        command,
        params,
        sessionId: 's-b',
        projectId: 'p-b'
      })
    })
    return { status: res.status, body: await res.json() }
  }
  const navigate = await call('browser.navigate', { url: 'about:blank' })
  ok(
    navigate.status === 200 && navigate.body.ok === true && seen[0] === 'browser.navigate',
    '能力服务：browser.navigate 已登记并落到 handler',
    JSON.stringify(navigate.body).slice(0, 120)
  )
  const network = await call('browser.network')
  ok(
    network.status === 200 && network.body.ok === true && seen[1] === 'browser.network',
    '能力服务：browser.network 已登记并落到 handler',
    JSON.stringify(network.body).slice(0, 120)
  )
  const evaluate = await call('browser.evaluate', { script: '1+1' })
  ok(
    evaluate.status === 400 && evaluate.body.error === 'unknown_command',
    '能力服务：browser.evaluate 有意不登记（不提供任意页面 JavaScript）'
  )
  server.stop()
  await rm(opsDir, { recursive: true, force: true })

  const env = { ...process.env }
  for (const key of ['YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']) delete env[key]
  const runYan = (args) =>
    spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', ...args], { encoding: 'utf8', env })
  const jsonOf = (stdout) => {
    const line = String(stdout)
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('{'))
      .pop()
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }
  const looksLikeStack = (text) => /\n\s+at\s+\S/.test(text) || /\bat\s+\S+\s+\(\S+:\d+:\d+\)/.test(text)

  const typo = runYan(['browser', 'frobnicate'])
  const typoBody = jsonOf(typo.stderr)
  ok(typo.status === 2, 'yan CLI：未知子命令走用法退出码 2')
  ok(/未知的 browser 子命令/.test(String(typoBody?.error ?? '')), 'yan CLI：未知子命令给中文提示')
  ok(!looksLikeStack(typo.stderr ?? ''), 'yan CLI：未知子命令不抛堆栈')

  const missingArg = runYan(['browser', 'navigate'])
  const missingBody = jsonOf(missingArg.stderr)
  ok(missingArg.status === 2, 'yan CLI：漏参数走用法退出码 2')
  ok(/--url/.test(String(missingBody?.error ?? '')), 'yan CLI：漏参数指出缺哪个 flag')
  ok(!looksLikeStack(missingArg.stderr ?? ''), 'yan CLI：漏参数不抛堆栈')

  const noHost = runYan(['browser', 'observe'])
  ok(noHost.status === 3, 'yan CLI：没有宿主环境变量时走「不可用」退出码 3')
  ok(/宿主能力服务不可用/.test(noHost.stderr ?? ''), 'yan CLI：说明是宿主不可用（不是命令不存在）')

}

{
  const { normalizeMessage } = await import('../out/test/normalize.mjs')
  const { projectHistory } = await import('../out/test/projector.mjs')
  const userMsg = { role: 'user', content: '你好' }
  const asstMsg = { role: 'assistant', content: [{ type: 'text', text: '在' }] }

  const legacy = projectHistory([userMsg, asstMsg])
  ok(
    legacy[0]?.id === 'm0' && legacy[1]?.id === 'm1',
    '历史编号：旧版 JSONL（无 system）从 m0 起',
    legacy.map((m) => m.id).join(',')
  )

  const withSystem = projectHistory([{ role: 'system', content: 'prompt' }, userMsg, asstMsg])
  ok(
    withSystem.length === 2 && withSystem[0]?.id === 'm0' && withSystem[0]?.role === 'user',
    '历史编号：跳过 Pi 0.87 写进 JSONL 的 system，用户消息仍是 m0',
    withSystem.map((m) => `${m.id}:${m.role}`).join(',')
  )

  const liveFirst = normalizeMessage(userMsg, 0)
  ok(
    !!liveFirst && liveFirst.id === withSystem[0]?.id,
    '历史与实时的用户消息 id 一致（回合计时锚点才对得上）'
  )

  const withEntry = projectHistory([userMsg, asstMsg], undefined, ['90ac64b9', '23cb6928'])
  ok(
    withEntry[0]?.entryId === '90ac64b9' && withEntry[1]?.entryId === '23cb6928',
    '历史读回：entry.id 挂到消息上（fork 锚点）',
    withEntry.map((m) => m.entryId).join(',')
  )
  const noEntry = normalizeMessage(userMsg, 0)
  ok(noEntry?.entryId === undefined, '实时消息（无文件上下文）不带 entryId')
}

const outlineTurns = await buildTest('src/shared/outline-turns.ts', 'out/test/outline-turns.mjs', { platform: 'neutral' })
    .then(() => import('../out/test/outline-turns.mjs'))
const { runOutlineTurnTests } = await import('./test-outline-turns.mjs')
runOutlineTurnTests(ok, outlineTurns)

const fsPromises = await import('node:fs/promises')

const pdfText = await buildTest('src/main/office/pdf-text.ts', 'out/test/pdf-text.mjs', { external: ['pdfjs-dist', 'pdfjs-dist/*'] }).then(() => import('../out/test/pdf-text.mjs'))
const { runPdfTextTests } = await import('./test-pdf-text.mjs')
await guarded("runPdfTextTests(ok, pdfText)", () => runPdfTextTests(ok, pdfText))

const userSkillShared = await buildTest('src/shared/user-skill.ts', 'out/test/user-skill.mjs', { platform: 'neutral' }).then(() => import('../out/test/user-skill.mjs'))
const userSkillMain = await buildTest('src/main/user-skills.ts', 'out/test/user-skills.mjs', { external: ['electron'] }).then(() => import('../out/test/user-skills.mjs'))
const { runUserSkillTests } = await import('./test-user-skill.mjs')
await guarded("runUserSkillTests(ok, userSkillShared, userSkillMain, { mkdt", () => runUserSkillTests(ok, userSkillShared, userSkillMain, { mkdtemp: fsPromises.mkdtemp, rm: fsPromises.rm }))

const subagentBrief = await buildTest('src/shared/subagent-brief.ts', 'out/test/subagent-brief.mjs', { platform: 'neutral' }).then(() => import('../out/test/subagent-brief.mjs'))
const { runSubagentBriefTests } = await import('./test-subagent-brief.mjs')
runSubagentBriefTests(ok, subagentBrief)

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  const bundle = async (entry, out) => {
    await buildTest(entry, out, { platform: 'neutral' })
    return import('../' + out)
  }
  const outcome = await bundle('src/shared/subagent-outcome.ts', 'out/test/subagent-outcome.mjs')
  const notice = await bundle('src/shared/subagent-notice.ts', 'out/test/subagent-notice.mjs')
  const repeatGuard = await import('../resources/pi-extensions/repeat-guard.js')
  const { runSubagentOutcomeTests } = await import('./test-subagent-outcome.mjs')
  runSubagentOutcomeTests(ok, { outcome, notice, brief: subagentBrief, repeatGuard })
}

const searchMod = await build({
    stdin: { contents: "export * from './src/main/search/search'\nexport * from './src/main/search/public-sources'", resolveDir: process.cwd(), loader: 'ts' },
    outfile: 'out/test/search.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/search.mjs'))
const { runSearchTests } = await import('./test-search.mjs')
await guarded("runSearchTests(ok, searchMod)", () => runSearchTests(ok, searchMod))
const { runWebResearchTests } = await import('./test-web-research.mjs')
await guarded("runWebResearchTests()", () => runWebResearchTests())

{
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const dataDir = mkdtempSync(join(tmpdir(), 'yan-search-providers-'))
  const stub = join(dataDir, 'electron-stub.mjs')
  writeFileSync(stub, 'export const BrowserWindow = class {}\nexport const session = {}\n')
  const savedDataDir = process.env.YAN_DATA_DIR
  const savedPiDir = process.env.YAN_PI_DIR
  const savedDeepseekKey = process.env.DEEPSEEK_API_KEY
  process.env.YAN_DATA_DIR = dataDir
  process.env.YAN_PI_DIR = dataDir
  delete process.env.DEEPSEEK_API_KEY
  try {
    const entry = [
      "export * as config from './src/main/search/config.ts'",
      "export * as tavily from './src/main/search/tavily.ts'",
      "export * as deepseek from './src/main/search/deepseek.ts'",
      "export * as firecrawl from './src/main/search/firecrawl.ts'",
      "export * as context7 from './src/main/search/context7.ts'",
      "export * as plan from './src/main/search/plan.ts'",
      "export * as modifiers from './src/main/search/modifiers.ts'",
      "export * as ddg from './src/main/search/ddg.ts'",
      "export * as brave from './src/main/search/brave.ts'",
      "export * as shared from './src/shared/search.ts'"
    ].join('\n')
    await build({
        stdin: { contents: entry, resolveDir: resolve('.'), loader: 'ts' },
        outfile: 'out/test/search-providers.mjs',
        bundle: true,
        format: 'esm',
        platform: 'node',
        alias: { electron: stub },
        logLevel: 'silent'
      })
    const providers = await import('../out/test/search-providers.mjs')
    const { runSearchProviderTests } = await import('./test-search-providers.mjs')
    await runSearchProviderTests(ok, providers, dataDir)
  } finally {
    if (savedDataDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = savedDataDir
    if (savedPiDir === undefined) delete process.env.YAN_PI_DIR
    else process.env.YAN_PI_DIR = savedPiDir
    if (savedDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = savedDeepseekKey
  }
}

const capabilityServerMod = await buildTest('src/main/capability-server.ts', 'out/test/capability-server.mjs').then(() => import('../out/test/capability-server.mjs'))
const { runCapabilityResultTests } = await import('./test-capability-result.mjs')
await guarded("runCapabilityResultTests(ok, capabilityServerMod)", () => runCapabilityResultTests(ok, capabilityServerMod))

const browserWaitMod = await buildTest('src/shared/browser-wait.ts', 'out/test/browser-wait.mjs', { platform: 'neutral' }).then(() => import('../out/test/browser-wait.mjs'))
const { runBrowserWaitTests } = await import('./test-browser-wait.mjs')
await guarded("runBrowserWaitTests(ok, browserWaitMod)", () => runBrowserWaitTests(ok, browserWaitMod))

const buildNeutral = (entry, outfile) =>
  build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent'
    }).then(() => import(`../${outfile}`))
const browserInputMod = await buildNeutral('src/main/browser/InputController.ts', 'out/test/browser-input.mjs')
const browserRegistryMod = await buildNeutral('src/main/browser/ElementRegistry.ts', 'out/test/browser-registry.mjs')
const { runBrowserSelectTests } = await import('./test-browser-select.mjs')
await guarded("runBrowserSelectTests(ok, browserInputMod, browserRegistryMo", () => runBrowserSelectTests(ok, browserInputMod, browserRegistryMod))

const browserNetworkMod = await buildNeutral('src/main/browser/NetworkTracker.ts', 'out/test/browser-network.mjs')
const { runBrowserNetworkTests } = await import('./test-browser-network.mjs')
await guarded("runBrowserNetworkTests(ok, browserNetworkMod)", () => runBrowserNetworkTests(ok, browserNetworkMod))

const { runSessionReadEquivalenceTests } = await import('./test-session-read-equivalence.mjs')
await guarded("runSessionReadEquivalenceTests(ok)", () => runSessionReadEquivalenceTests(ok))
await guarded("import('./test-session-reader-stream.mjs')", () => import('./test-session-reader-stream.mjs'))
await guarded("import('./test-session-reader-branch.mjs')", () => import('./test-session-reader-branch.mjs'))

console.log(`\n${pass}/${pass + fail} 通过`)
if (inProcessFailures.length) {
  console.log(`\n${inProcessFailures.length} 个进程内测试失败：${inProcessFailures.map((item) => item.label).join(', ')}`)
  for (const item of inProcessFailures) console.log(`\n--- ✗ ${item.label} ---\n${item.detail}`)
}
await rm(dataDir, { recursive: true, force: true })
process.exit(fail || inProcessFailures.length ? 1 : 0)
