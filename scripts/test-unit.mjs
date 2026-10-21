import { mkdtemp, writeFile, mkdir, rm, readdir, readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { applyTestEnv, isIsolatedTestEnv } from './lib/test-env.mjs'
import { runHtmlArtifactPreviewTests } from './test-html-artifact-preview.mjs'
import { runRunStateTests } from './test-run-state.mjs'
import { runCapabilityNegotiationTests } from './test-capability-negotiation.mjs'
import { runSessionConcurrencyConflictTests } from './test-session-concurrency-conflict.mjs'
import { runSessionConcurrencyFrontendTests } from './test-session-concurrency-frontend.mjs'
import { runSessionStatsIsolationTests } from './test-session-stats-isolation.mjs'
import { runSessionConcurrencySendGuardTests } from './test-session-concurrency-send-guard.mjs'
import { runSessionConcurrencyFinalEdgesTests } from './test-session-concurrency-final-edges.mjs'
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

applyTestEnv()
const isolatedEnv = isIsolatedTestEnv()

await import('./test-live-synthetic-isolation.mjs')
await import('./test-ui-survey-regressions.mjs')
await import('./test-light-client.mjs')
await import('./test-light-hotpaths.mjs')
await import('./test-model-selection.mjs')
await import('./test-cc-guard.mjs')
await runHtmlArtifactPreviewTests()
await runRunStateTests()
await runCapabilityNegotiationTests()
await import('./test-security-performance-fixes.mjs')
await import('./test-browser-frame-origin.mjs')
await import('./test-v3-deeplink.mjs')
const inProcessScripts = [
  'test-attachment-prune-race', 'test-files-root-boundary',
  'test-mobile-model-url', 'test-open-path-boundary',
  'test-package-sources-fixture', 'test-package-timeout-fallback',
  'test-session-restore-rollback', 'test-subagent-stop-intent',
  'test-title-lifecycle', 'test-write-file-durable', 'test-project-directory'
]
for (const script of inProcessScripts) await import(`./${script}.mjs`)

const spawnedScripts = [
  'test-mcp-annotations-guard', 'test-terminal-status', 'test-taskbar-status',
  'test-mcp-native-import', 'test-turn-model', 'test-command-palette', 'test-acquired-skills',
  'test-readonly-model-registration', 'test-mcp-image-results',
  'test-stream-loop-detector', 'test-stream-loop-settings', 'test-smooth-text-settings',
  'test-native-session-export-alias', 'test-schedule-safety', 'test-subagent-terminal-races',
  'test-provider-probe-protocol', 'test-remote-chain-target', 'test-retired-hub-cli',
  'test-session-move-continuation', 'test-subagent-dismiss', 'test-subagent-dismiss-ui',
  'test-v3-quota-card', 'test-v3-turn-changes', 'test-model-bot', 'test-notification-bot-icon', 'test-v3-tool-tiles', 'test-split-drop-model', 'test-sidebar-content-search',
  'test-turn-outcome-title-text', 'test-subagent-model-label', 'test-subagent-task-rows', 'test-subagent-composer', 'test-subagent-panes', 'test-background-tasks','test-system-prompt-sections', 'test-session-message-count', 'test-markdown-blocks', 'test-smooth-reveal', 'test-user-text', 'test-session-find', 'test-session-visual-logic',
  'test-runs-registry', 'test-runs-history', 'test-v3-runs-subagent',
  'test-skill-manager', 'test-sync-resolve', 'test-command-params', 'test-quit-guard', 'test-approval-ledger', 'test-approval-feedback', 'test-session-operation-gate', 'test-host-tools', 'test-session-items', 'test-tool-run-model', 'test-danger-block', 'test-tool-title', 'test-v3-splitter', 'test-v3-confirm-action', 'test-working-line-model',
  'test-rail-stats', 'test-file-services', 'test-git-services', 'test-file-name-search', 'test-terminal-registry', 'test-v3-terminal-tabs', 'test-preview-site-access', 'test-browser-allowed-sites', 'test-remote-image', 'test-preload-renderer-ready', 'test-browser-observe-live', 'test-browser-screenshot-timeout', 'test-subagent-fork', 'test-sidebar-shell', 'test-v3-changes-scope', 'test-v3-changes-pane-actions', 'test-v3-files-panel', 'test-changes-file-list', 'test-diff-separators', 'test-files-search', 'test-file-type-icons', 'test-evidence-dir', 'test-preview-code-view', 'test-preview-formats', 'test-preview-pdf',
  'test-session-reattach',
  'test-composer-draft-store',
  'test-composer-text',
  'test-composer-edit',
  'test-transcript-view',
  'test-composer-menu-layout',
  'test-tile-fit',
  'test-tile-layouts',
  'test-composer-keys',
  'test-prompt-history',
  'test-v3-approval-card'
]

const spawnFailures = []

function runScript(script, timeoutMs) {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [`scripts/${script}.mjs`], {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs
  })
  const elapsed = Date.now() - startedAt
  if (!result.error && result.status === 0) {
    console.log(`✓ ${script} (${elapsed}ms)`)
    return
  }
  const detail = result.error?.message ?? result.signal ?? result.status
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const tail = output.split('\n').slice(-40).join('\n')
  const logPath = join('out', 'test-failures', `${script}.log`)
  mkdirSync(join('out', 'test-failures'), { recursive: true })
  try {
    writeFileSync(logPath, output)
  } catch {
  }
  console.log(`✗ ${script} (${elapsed}ms) ${detail}`)
  spawnFailures.push({ script, detail, tail, logPath })
}

for (const script of spawnedScripts) runScript(script, 60_000)

const scriptsOutsideUnitRun = {
  'test-unit': 'the-harness-itself',
  'test-live': 'live-harness',
  'test-packaged': 'needs-packaged-release',
  'test-upgrade-read': 'needs-packaged-release',
  'test-relay-mobile': 'needs-mobile-dependencies',
  'test-v3-story-coverage': 'story-matrix-missing-tooltip-hint',
  'test-hermes-plugin-desktop': 'sessions-list-race-in-unit-run',
  'test-cc-delegation-live': 'needs-real-claude-subscription',
  'test-cc-subagent-live': 'needs-real-claude-subscription',
  'test-cc-subscription-live': 'needs-real-claude-subscription',
  'test-cross-provider-live': 'needs-real-claude-subscription',
  'test-git-runtime-real': 'needs-real-portablegit-download',
  'test-luna-progress-live': 'needs-real-luna-account'
}

async function pendingScripts() {
  const files = (await readdir('scripts'))
    .filter((name) => /^test-.*\.mjs$/.test(name))
    .map((name) => name.slice(0, -4))
  const ownSource = await readFile(new URL(import.meta.url), 'utf8')
  const referenced = new Set([...ownSource.matchAll(/\.\/(test-[a-z0-9-]+)\.mjs/g)].map((match) => match[1]))
  for (const name of inProcessScripts) referenced.add(name)
  for (const name of spawnedScripts) referenced.add(name)
  return files.filter((name) => !referenced.has(name) && !Object.hasOwn(scriptsOutsideUnitRun, name)).sort()
}

const scannedScripts = await pendingScripts()
if (scannedScripts.length) console.log(`目录扫描新增 ${scannedScripts.length} 个：${scannedScripts.join(', ')}`)
for (const script of scannedScripts) runScript(script, 120_000)

const dir = await mkdtemp(join(tmpdir(), 'yan-sessions-'))
const dataDir = await mkdtemp(join(tmpdir(), 'yan-data-'))
process.env.YAN_SESSIONS_DIR = dir
process.env.YAN_DATA_DIR = dataDir

const { listSessions, deleteSession, readTitleSamples, restoreSession, SESSIONS_DIR } = await import('../out/main/sessions.js')

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/turns.ts'],
    outfile: 'out/test/turns.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/turn-timing.ts'],
    outfile: 'out/test/turn-timing.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/file-resource.ts'],
    outfile: 'out/test/file-resource.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/duration.ts'],
    outfile: 'out/test/duration.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/turn-timing-store.ts'],
    outfile: 'out/test/turn-timing-store.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/zoom-math.ts'],
    outfile: 'out/test/zoom-math.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/agent.ts'],
    outfile: 'out/test/agent.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    plugins: [{ name: 'unit-electron-boundary', setup(builder) {
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
    } }],
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/artifacts.ts'],
    outfile: 'out/test/artifacts.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/image-generation.ts'],
    outfile: 'out/test/image-generation.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/keep-images.ts'],
    outfile: 'out/test/keep-images.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/attachments.ts'],
    outfile: 'out/test/attachments.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runAttachmentTests } = await import('./test-attachments.mjs')
const { runKeepImagesTests } = await import('./test-keep-images.mjs')
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/queue-images.ts'],
    outfile: 'out/test/queue-images.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
const { runQueueImageTests } = await import('./test-queue-draft-images.mjs')
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/same-messages.ts'],
    outfile: 'out/test/same-messages.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
const { runSameMessagesTests } = await import('./test-same-messages.mjs')
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/session-reader.ts'],
    outfile: 'out/test/session-reader.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runSessionImageTests } = await import('./test-session-images.mjs')
const { runArtifactTests } = await import('./test-artifacts.mjs')
await runArtifactTests()
await import('./test-image-generation-boundaries.mjs')
const { runTurnTests } = await import('./test-turns.mjs')
const { runTurnTimingTests } = await import('./test-turn-timing.mjs')
const { runDurationTests } = await import('./test-duration.mjs')
const { runTurnTimingStoreTests } = await import('./test-turn-timing-store.mjs')
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

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/snapshots.ts'],
    outfile: 'out/test/snapshots.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/links.ts'],
    outfile: 'out/test/links.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/browser-navigation.ts'],
    outfile: 'out/test/browser-navigation.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/workspace-key.ts'],
    outfile: 'out/test/workbench.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)


await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/subagent-usage.ts'],
    outfile: 'out/test/subagent-usage.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/subagent-view.ts'],
    outfile: 'out/test/subagent-view.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/browser-visibility.ts'],
    outfile: 'out/test/browser-visibility.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/file-refs.ts'],
    outfile: 'out/test/file-refs.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/chrome-profile.ts'],
    outfile: 'out/test/chrome-profile.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runChromeProfileTests } = await import('./test-chrome-profile.mjs')

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/ipc.ts'],
    outfile: 'out/test/ipc.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
const { runQuestionTests } = await import('./test-question.mjs')

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/todo-snapshots.ts'],
    outfile: 'out/test/todo-snapshots.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
const { runTodoHistoryTests } = await import('./test-todo-history.mjs')
const { runRepeatGuardTests } = await import('./test-repeat-guard.mjs')

const taskPlan = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/task-plan.ts'],
    outfile: 'out/test/task-plan.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/task-plan.mjs'))
)
const { runTaskPlanTests } = await import('./test-task-plan.mjs')

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/task-plan-store.ts'],
    outfile: 'out/test/task-plan-store.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runTaskPlanStoreTests } = await import('./test-task-plan-store.mjs')

const projectMemory = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/project-memory.ts'],
    outfile: 'out/test/project-memory.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/project-memory.mjs'))
)
const projectMemoryStore = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/project-memory-store.ts'],
    outfile: 'out/test/project-memory-store.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/project-memory-store.mjs'))
)
const { runProjectMemoryTests } = await import('./test-project-memory.mjs')

const projectMemorySearch = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/project-memory-search.ts'],
    outfile: 'out/test/project-memory-search.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/project-memory-search.mjs'))
)
const { runProjectKnowledgeSearchTests } = await import('./test-project-memory-search.mjs')

const capabilityCatalogShared = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/capabilities.ts'],
    outfile: 'out/test/capabilities.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/capabilities.mjs'))
)
const capabilitySkillService = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/skill-service.ts'],
    outfile: 'out/test/capabilities-skill.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/capabilities-skill.mjs'))
)
const capabilityCatalogMain = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/catalog.ts'],
    outfile: 'out/test/capabilities-catalog.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/capabilities-catalog.mjs'))
)
const { runCapabilityCatalogTests } = await import('./test-capabilities.mjs')

const discoveryShared = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/discovery.ts'],
    outfile: 'out/test/discovery.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/discovery.mjs'))
)
const discoveryMain = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/discovery/discover.ts'],
    outfile: 'out/test/discovery-src.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/discovery-src.mjs'))
)
const { runDiscoveryTests } = await import('./test-discovery.mjs')

const acquisitionShared = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/acquisition.ts'],
    outfile: 'out/test/acquisition.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/acquisition.mjs'))
)
const skillSecurity = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/skill-security.ts'],
    outfile: 'out/test/skill-security.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/skill-security.mjs'))
)
const acquisitionService = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/acquisition-service.ts'],
    outfile: 'out/test/acquisition-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/acquisition-service.mjs'))
)
const piPackageScheduler = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/pi-package-scheduler.ts'],
    outfile: 'out/test/pi-package-scheduler.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/pi-package-scheduler.mjs'))
)
const npmArtifact = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/npm-artifact.ts'],
    outfile: 'out/test/npm-artifact.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['tar'],
    logLevel: 'silent'
  }).then(() => import('../out/test/npm-artifact.mjs'))
)
const npmAcquisition = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/npm-acquisition.ts'],
    outfile: 'out/test/npm-acquisition.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['tar'],
    logLevel: 'silent'
  }).then(() => import('../out/test/npm-acquisition.mjs'))
)
const packageAuthorizationShared = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/package-authorization.ts'],
    outfile: 'out/test/package-authorization.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/package-authorization.mjs'))
)
const packageAuthorizationService = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/package-authorization-service.ts'],
    outfile: 'out/test/package-authorization-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/package-authorization-service.mjs'))
)
const piPackageSmoke = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/pi-package-smoke.ts'],
    outfile: 'out/test/pi-package-smoke.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['tar'],
    logLevel: 'silent'
  }).then(() => import('../out/test/pi-package-smoke.mjs'))
)
const { runAcquisitionTests } = await import('./test-acquisition.mjs')
const { runSkillSecurityTests } = await import('./test-skill-security.mjs')
const { runPiPackageSchedulerTests } = await import('./test-pi-package-scheduler.mjs')
const { runPiPackageSmokeTests } = await import('./test-pi-package-smoke.mjs')

const mcpShared = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/mcp.ts'],
    outfile: 'out/test/mcp.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/mcp.mjs'))
)
const mcpConfig = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/mcp/config.ts'],
    outfile: 'out/test/mcp-config.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/mcp-config.mjs'))
)
const mcpManager = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/mcp/connection-manager.ts'],
    outfile: 'out/test/mcp-manager.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    logLevel: 'silent'
  }).then(() => import('../out/test/mcp-manager.mjs'))
)
const mcpToolService = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/mcp/tool-service.ts'],
    outfile: 'out/test/mcp-tool.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    logLevel: 'silent'
  }).then(() => import('../out/test/mcp-tool.mjs'))
)
const { runMcpTests } = await import('./test-mcp.mjs')

const mcpRegistrationShared = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/mcp-registration.ts'],
    outfile: 'out/test/mcp-registration.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/mcp-registration.mjs'))
)
const { runMcpRegistrationTests } = await import('./test-mcp-registration.mjs')

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/extensions-inventory.ts'],
    outfile: 'out/test/extensions-inventory.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runExtensionInventoryTests } = await import('./test-extension-inventory.mjs')

const subagentIsolation = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/subagent-isolation.ts'],
    outfile: 'out/test/subagent-isolation.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/subagent-isolation.mjs'))
)
const { runSubagentIsolationTests } = await import('./test-subagent-isolation.mjs')

const { SubagentController } = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/subagents.ts'],
    outfile: 'out/test/subagents.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/subagents.mjs'))
)
const { runSubagentControllerTests } = await import('./test-subagents.mjs')

const projectId = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/project-id.ts'],
    outfile: 'out/test/project-id.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/project-id.mjs'))
)
const { runProjectIdTests } = await import('./test-project-id.mjs')

const projectSession = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/project-session.ts'],
    outfile: 'out/test/project-session.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/project-session.mjs'))
)
const { runProjectSessionTests } = await import('./test-project-session.mjs')

const { runQueueItemsTests } = await import('./test-queue-items.mjs')
const queueItems = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/queue-items.ts'],
    outfile: 'out/test/queue-items.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/queue-items.mjs'))
)

const { RunnerRegistry } = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/runners.ts'],
    outfile: 'out/test/runners.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/runners.mjs'))
)

const { migrateSessionRuntime, reduceSessionRuntime, sessionRuntimeKey, updateSessionRuntime } = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/session-runtime.ts'],
    outfile: 'out/test/session-runtime.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/session-runtime.mjs'))
)

const pushRouting = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/push-routing.ts'],
    outfile: 'out/test/push-routing.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/push-routing.mjs'))
)

const sessionLayout = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/session-layout.ts'],
    outfile: 'out/test/session-layout.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/session-layout.mjs'))
)

const exitSnapshot = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/exit-snapshot.ts'],
    outfile: 'out/test/exit-snapshot.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/exit-snapshot.mjs'))
)

const commandRegistry = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/command-registry.ts'],
    outfile: 'out/test/command-registry.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/command-registry.mjs'))
)

const modelCapabilities = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/model-capabilities.ts'],
    outfile: 'out/test/model-capabilities.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/model-capabilities.mjs'))
)

const buildInfo = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/build-info.ts'],
    outfile: 'out/test/build-info.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/build-info.mjs'))
)

const networkPolicy = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/browser/network-policy.ts'],
    outfile: 'out/test/network-policy.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/network-policy.mjs'))
)

const manualTitle = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/title.ts'],
    outfile: 'out/test/title.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/title.mjs'))
)

const networkBoundary = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/browser/network-boundary.ts'],
    outfile: 'out/test/network-boundary.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/network-boundary.mjs'))
)

const atQuery = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/features/composer/at-query.ts'],
    outfile: 'out/test/at-query.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/at-query.mjs'))
)
const { runAtQueryTests } = await import('./test-at-query.mjs')

const fileListing = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/files.ts'],
    outfile: 'out/test/files.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/files.mjs'))
)
const { runFileListingTests } = await import('./test-files.mjs')
const { runFilesWatchTests } = await import('./test-files-watch.mjs')
const { runOpenGuardTests } = await import('./test-open-guard.mjs')
const { runRailSectionsTests } = await import('./test-rail-sections.mjs')
const { runTileTreeTests } = await import('./test-tile-tree.mjs')
await import('./test-chat-tree.mjs')

const [tileTree, tileDropZones, tileDropIndicator] = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  Promise.all(
    ['tile-tree', 'tile-drop-zones', 'tile-drop-indicator'].map((name) =>
      build({
        entryPoints: [`src/renderer/src/features/workbench/${name}.ts`],
        outfile: `out/test/${name}.mjs`,
        bundle: true,
        format: 'esm',
        platform: 'node',
        logLevel: 'silent'
      }).then(() => import(`../out/test/${name}.mjs`))
    )
  )
)

const railSections = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/features/workbench/rail-sections.ts'],
    outfile: 'out/test/rail-sections.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/rail-sections.mjs'))
)

const openGuard = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/open-guard.ts'],
    outfile: 'out/test/open-guard.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/open-guard.mjs'))
)

const filesWatch = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/files-watch.ts'],
    outfile: 'out/test/files-watch.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/files-watch.mjs'))
)

const fileContentSearch = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/file-content-search.ts'],
    outfile: 'out/test/file-content-search.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/file-content-search.mjs'))
)

const fileEditor = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/file-editor.ts'],
    outfile: 'out/test/file-editor.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/file-editor.mjs'))
)

const slashQuery = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/features/composer/slash-query.ts'],
    outfile: 'out/test/slash-query.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/slash-query.mjs'))
)
const { runSlashQueryTests } = await import('./test-slash-query.mjs')

const capabilityRequest = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/capability-request.ts'],
    outfile: 'out/test/capability-request.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/capability-request.mjs'))
)
const { runCapabilityRequestTests } = await import('./test-capability-request.mjs')

const compactionEvents = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/compaction.ts'],
    outfile: 'out/test/compaction.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/compaction.mjs'))
)
const compactionView = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/compaction-view.ts'],
    outfile: 'out/test/compaction-view.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/compaction-view.mjs'))
)

const stdioGuard = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/stdio-guard.ts'],
    outfile: 'out/test/stdio-guard.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/stdio-guard.mjs'))
)

const remoteServer = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/remote-server.ts'],
    outfile: 'out/test/remote-server.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/remote-server.mjs'))
)
const { runRemoteServerTests } = await import('./test-remote.mjs')
const peerDeps = await import('../node_modules/esbuild/lib/main.js').then(async ({ build }) => {
  const out = {}
  for (const [entry, name] of [['src/main/remote-devices.ts', 'remote-devices'], ['src/main/peer-grants.ts', 'peer-grants']]) {
    await build({ entryPoints: [entry], outfile: `out/test/${name}.mjs`, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
    Object.assign(out, await import(`../out/test/${name}.mjs`))
  }
  return out
})
const { runPeerTests } = await import('./test-peer.mjs')

const quotaCommandCode = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/quota-commandcode.ts'],
    outfile: 'out/test/quota-commandcode.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/quota-commandcode.mjs'))
)

const quotaTone = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/quota-tone.ts'],
    outfile: 'out/test/quota-tone.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/quota-tone.mjs'))
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/normalize.ts'],
    outfile: 'out/test/normalize.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({ entryPoints: ['src/main/session-items/projector.ts'], outfile: 'out/test/projector.mjs', bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
)

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

await runSessionConcurrencyConflictTests(ok)
await runSessionConcurrencyFrontendTests(ok)
await runSessionStatsIsolationTests(ok)

await runSessionConcurrencySendGuardTests(ok)
await runSessionConcurrencyFinalEdgesTests(ok)
await runCommandCodeQuotaDisplayTests(ok)
await runSubagentActiveVisibilityTests(ok)
await runSubagentParentOwnershipTests(ok)

await runSessionSyncRaceTests(ok)
await runHostOwnershipTests(ok)
await runSnapshotIdentityTests(ok)
await runExecutionAdmissionTests(ok)
await runEpochSnapshotTests(ok)
await runAccountQuotaPaneTests(ok)

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


console.log('\n--- 7. 缓存：内容没变时不重读 ---')
const before = (await listSessions()).find((s) => s.id === 'aaa')
const after = (await listSessions()).find((s) => s.id === 'aaa')
ok(before === after || (before?.title === after?.title && before?.updatedAt === after?.updatedAt), '两次调用结果一致')


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
const branchToken = await deleteSession(branchRoot)
const afterBranchDelete = await listSessions()
ok(![branchRoot, branchChild, branchGrandchild].some((p) => afterBranchDelete.some((s) => s.path === p)), '删除父会话会移除整棵父子孙树')
await restoreSession(branchToken)
const afterBranchRestore = await listSessions()
ok([branchRoot, branchChild, branchGrandchild].every((p) => afterBranchRestore.some((s) => s.path === p)), '撤销删除会恢复整棵父子孙树')

let protectedRejected = false
try { await deleteSession(branchRoot, branchGrandchild) } catch { protectedRejected = true }
ok(protectedRejected, '当前会话位于子树时拒绝删除父会话')
const afterProtected = await listSessions()
ok([branchRoot, branchChild, branchGrandchild].every((p) => afterProtected.some((s) => s.path === p)), '拒绝删除时不会移动任何分支文件')

const undoToken = await deleteSession(pPath)
list = await listSessions()
ok(!list.some((s) => s.id === 'ccc'), '删除后列表里没有了')
await restoreSession(undoToken)
list = await listSessions()
ok(list.some((s) => s.id === 'ccc'), '撤销后会话恢复到原路径')

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


await runTurnTests(ok)
await runTurnTimingTests(ok)
await runDurationTests(ok)
await runTurnTimingStoreTests(ok)


await runZoomTests(ok)


await runFileRefTests(ok)


await runLinkTests(ok)
await runFileResourceTests(ok)

const { runFileUrlTests } = await import('./test-file-url.mjs')
await runFileUrlTests(ok)

const { runSourceFilesTests } = await import('./test-source-files.mjs')
await runSourceFilesTests(ok)

const { runSessionSwitchTests } = await import('./test-session-switch.mjs')
await runSessionSwitchTests(ok)


await runWorkbenchTests(ok)


await runBrowserVisibilityTests(ok)


await runBrowserNavigationTests(ok)



await runSubagentViewTests(ok)


await runSubagentUsageTests(ok)


await runKeepImagesTests(ok)
await runQueueImageTests(ok)
await runSameMessagesTests(ok)
await runAttachmentTests(ok)
await runSessionImageTests(ok)




await runResponseDetailTests(ok)


await runSnapshotTests(ok)


await runChromeProfileTests(ok)




await runQuestionTests(ok)

await runRepeatGuardTests(ok)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/session-chain.ts'],
    outfile: 'out/test/session-chain.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/session-chain-service.ts'],
    outfile: 'out/test/session-chain-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runSessionChainTests } = await import('./test-session-chain.mjs')
await runSessionChainTests(ok)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/session-history.ts'],
    outfile: 'out/test/session-history.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runSessionHistoryTests } = await import('./test-session-history.mjs')
await runSessionHistoryTests(
  ok,
  await import('../out/test/session-history.mjs'),
  await import('../out/test/session-chain-service.mjs')
)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({ entryPoints: ['src/shared/model-errors.ts'], outfile: 'out/test/model-errors.mjs',
    bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
)
const { runModelErrorTests } = await import('./test-model-errors.mjs')
await runModelErrorTests(ok)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({ entryPoints: ['src/shared/quota-resume.ts'], outfile: 'out/test/quota-resume.mjs',
    bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
)
const { runQuotaResumeTests } = await import('./test-quota-resume.mjs')
await runQuotaResumeTests(ok)
await runTodoHistoryTests(ok)
await runTaskPlanTests(ok)
await runTaskPlanStoreTests(ok)
await runProjectMemoryTests(ok, { memory: projectMemory, store: projectMemoryStore })
await runCapabilityCatalogTests(ok, {
  capabilities: capabilityCatalogShared,
  skill: capabilitySkillService,
  catalog: capabilityCatalogMain
})

await runDiscoveryTests(ok, { shared: discoveryShared, discover: discoveryMain })
await runAcquisitionTests(ok, {
  shared: acquisitionShared,
  service: acquisitionService,
  npmArtifact,
  npmAcquisition,
  packageAuthorizationShared,
  packageAuthorizationService
})
await runSkillSecurityTests(ok, skillSecurity)
await runPiPackageSchedulerTests(ok, {
  AcquisitionService: acquisitionService.AcquisitionService,
  PiPackageActivationScheduler: piPackageScheduler.PiPackageActivationScheduler
})
await runPiPackageSmokeTests(ok, piPackageSmoke)
await runMcpTests(ok, {
  mcp: mcpShared,
  config: mcpConfig,
  manager: mcpManager,
  toolService: mcpToolService
})
await runMcpRegistrationTests(ok, { shared: mcpRegistrationShared })
runProjectKnowledgeSearchTests(ok, projectMemorySearch)
await runExtensionInventoryTests(ok)

await runSubagentIsolationTests(ok, subagentIsolation)

await runSubagentControllerTests(ok, SubagentController)

runProjectIdTests(ok, projectId)

runProjectSessionTests(ok, projectSession)

runQueueItemsTests(ok, queueItems)

const workspaceChanges = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/snapshots.ts'],
    outfile: 'out/test/snapshots.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/snapshots.mjs'))
)
const { runWorkspaceChangesTests } = await import('./test-workspace-changes.mjs')
runWorkspaceChangesTests(ok, workspaceChanges)

{
  const { runRunnerTests } = await import('./test-runners.mjs')
  await runRunnerTests(ok, RunnerRegistry)
  const { runRunnerReclaimTests } = await import('./test-runner-reclaim.mjs')
  await runRunnerReclaimTests(ok)
}

{
  const { runSessionRuntimeTests } = await import('./test-session-runtime.mjs')
  runSessionRuntimeTests(ok, reduceSessionRuntime, sessionRuntimeKey, updateSessionRuntime, migrateSessionRuntime)
}

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
  const { runHiddenPageTests } = await import('./test-hidden-page.mjs')
  await runHiddenPageTests(ok)
}

runAtQueryTests(ok, atQuery)
{
  const { runQuotaCommandCodeTests, runQuotaToneTests } = await import('./test-quota.mjs')
  runQuotaCommandCodeTests(ok, quotaCommandCode)
  runQuotaToneTests(ok, quotaTone)
}
runSlashQueryTests(ok, slashQuery)
runCapabilityRequestTests(ok, capabilityRequest)
await runFileListingTests(ok, fileListing)
await runFilesWatchTests(ok, filesWatch)
await runOpenGuardTests(ok, openGuard)
await runRailSectionsTests(ok, railSections)
await runTileTreeTests(ok, tileTree, tileDropZones, tileDropIndicator)
await runFileContentSearchTests(ok, fileContentSearch)
await runFileEditorTests(ok, fileEditor)

const { runCredentialsTests } = await import('./test-credentials.mjs')
await runCredentialsTests(ok)

const { runSettingsStoreTests } = await import('./test-settings-store.mjs')
await runSettingsStoreTests(ok)

const { runOAuthTests } = await import('./test-oauth.mjs')
await runOAuthTests(ok)

const { runStreamDeltasTests } = await import('./test-stream-deltas.mjs')
await runStreamDeltasTests(ok)

const titleSampleMod = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/title-samples.ts'],
    outfile: 'out/test/title-samples.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/title-samples.mjs'))
)
const { runTitleSampleTests } = await import('./test-title-samples.mjs')
runTitleSampleTests(ok, titleSampleMod)

const { runCompactionStatusTests } = await import('./test-compaction-status.mjs')
runCompactionStatusTests(ok, compactionEvents, compactionView)

const { runStdioGuardTests } = await import('./test-stdio-guard.mjs')
runStdioGuardTests(ok, stdioGuard)

await runRemoteServerTests(ok, remoteServer)
await runPeerTests(ok, { ...remoteServer, ...peerDeps })
const { runRemoteDeviceTests } = await import('./test-remote-devices.mjs')
await runRemoteDeviceTests(ok, peerDeps)

const languageExtension = await import('../resources/pi-extensions/language.js')
const { runLanguageExtensionTests } = await import('./test-language-extension.mjs')
await runLanguageExtensionTests(ok, languageExtension)

const preambleExtension = await import('../resources/pi-extensions/preamble.js')
const { runPreambleExtensionTests } = await import('./test-preamble-extension.mjs')
await runPreambleExtensionTests(ok, preambleExtension)
{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await build({ entryPoints: ['src/shared/context-limits.ts'], outfile: 'out/test/context-limits.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const contextTrim = await import('../resources/pi-extensions/context-trim.js')
  const contextLimits = await import('../out/test/context-limits.mjs')
  const { runContextTrimTests } = await import('./test-context-trim.mjs')
  await runContextTrimTests(ok, contextTrim, contextLimits)
}
const { runAppUpdateTests } = await import('./test-app-update.mjs')
await runAppUpdateTests(ok)

const ipcError = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/ipc-error.ts'],
    outfile: 'out/test/ipc-error.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/ipc-error.mjs'))
)
const { runIpcErrorTests } = await import('./test-ipc-error.mjs')
await runIpcErrorTests(ok, ipcError)

const webSearch = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/web-search.ts'],
    outfile: 'out/test/web-search.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/web-search.mjs'))
)
const { runWebSearchTests } = await import('./test-web-search.mjs')
await runWebSearchTests(ok, webSearch)

const quotaMini = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/quota-mini.ts'],
    outfile: 'out/test/quota-mini.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/quota-mini.mjs'))
)
const { runQuotaMiniTests } = await import('./test-quota-mini.mjs')
await runQuotaMiniTests(ok, quotaMini)

const runProgress = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/run-progress.ts'],
    outfile: 'out/test/run-progress.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/run-progress.mjs'))
)
const { runRunProgressTests } = await import('./test-run-progress.mjs')
await runRunProgressTests(ok, runProgress)

const customProvider = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/custom-provider.ts'],
    outfile: 'out/test/custom-provider.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/custom-provider.mjs'))
)
const { runCustomProviderTests } = await import('./test-custom-provider.mjs')
await runCustomProviderTests(ok, customProvider)

const gitState = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/git.ts'],
    outfile: 'out/test/git.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/git.mjs'))
)
const { runGitStateTests } = await import('./test-git-state.mjs')
await runGitStateTests(ok, gitState)

const gitActions = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/git-actions.ts'],
    outfile: 'out/test/git-actions.mjs',
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    logLevel: 'warning'
  }).then(() => import('../out/test/git-actions.mjs'))
)
const { runGitActionTests } = await import('./test-git-actions.mjs')
await runGitActionTests(ok)

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  Promise.all([
    build({
      entryPoints: ['src/main/git-service.ts'],
      outfile: 'out/test/git-service.mjs',
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent'
    }),
    build({
      entryPoints: ['src/main/git-actions.ts'],
      outfile: 'out/test/git-actions-main.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning'
    }),
    build({
      entryPoints: ['src/main/git-worktree.ts'],
      outfile: 'out/test/git-worktree.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning'
    }),
    build({
      entryPoints: ['src/main/sources.ts'],
      outfile: 'out/test/sources.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning'
    }),
    build({
      entryPoints: ['src/main/worktree-links.ts'],
      outfile: 'out/test/worktree-links.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning'
    }),
    build({
      entryPoints: ['src/main/session-isolation.ts'],
      outfile: 'out/test/session-isolation.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning'
    }),
    build({
      entryPoints: ['src/main/question-log.ts'],
      outfile: 'out/test/question-log-store.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning'
    }),
    build({
      entryPoints: ['src/shared/question-log.ts'],
      outfile: 'out/test/question-log.mjs',
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      logLevel: 'warning'
    }),
    build({
      entryPoints: ['src/main/packages.ts'],
      outfile: 'out/test/packages.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning'
    })
  ])
)
const { runGitRepoTests } = await import('./test-git-repo.mjs')
const { runPackagesTests } = await import('./test-packages.mjs')
const { runSourcesTests } = await import('./test-sources.mjs')
const { runWorktreeLinkTests } = await import('./test-worktree-links.mjs')
const { runSessionIsolationTests } = await import('./test-session-isolation.mjs')
const { runQuestionLogTests } = await import('./test-question-log.mjs')
console.log('\n--- 宿主提问：回放合并 + 按会话落盘 ---')
await runQuestionLogTests(ok)
console.log('\n--- P2. pi 包管理（真实 pi CLI，隔离 agent 目录）---')
const piCliPath = join('resources', 'pi-runtime', 'dist', 'bundle', 'cli.js')
if (!existsSync(piCliPath)) throw new Error(`内置 pi CLI 不在（${piCliPath}）：先跑 npm run vendor:pi`)
await runPackagesTests(ok)
const { runPluginMarketTests } = await import('./test-plugin-market.mjs')
await runPluginMarketTests(ok)
const { runVisualBlockTests } = await import('./test-visual-blocks.mjs')
await runVisualBlockTests(ok)
const { runAppearanceTests } = await import('./test-appearance.mjs')
console.log('\n--- 外观个性化：字体、字号与背景色 ---')
await runAppearanceTests(ok)
const { runUsageStatsTests } = await import('./test-usage-stats.mjs')
console.log('\n--- 启动页用量概览：按行计数与范围聚合 ---')
await runUsageStatsTests(ok)
console.log('\n--- S1. 会话来源的持久化引用 ---')
await runSourcesTests(ok)
console.log('\n--- S2. 会话↔工作树来源关系（实施-07）---')
await runWorktreeLinkTests(ok)
console.log('\n--- S2b. 同一工作目录冲突 → 自动隔离与自动合回 ---')
await runSessionIsolationTests(ok)
await runGitRepoTests(ok)

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await build({
    entryPoints: ['src/main/capability-server.ts'],
    outfile: 'out/test/capability-server.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
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

  const notImpl = await call({ ...me, command: 'knowledge.search' })
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

  for (const command of ['knowledge.search', 'knowledge.read', 'knowledge.propose']) {
    const res = await call({ ...me, command })
    ok(
      res.status !== 400 || res.body.error !== 'unknown_command',
      `能力服务：${command} 已登记进宿主入口`,
      JSON.stringify(res.body)
    )
  }

  const badVersion = await call({ ...me, command: 'operations.status', apiVersion: 999 })
  ok(badVersion.status === 400, '能力服务：协议版本不一致被拒', JSON.stringify(badVersion.body))

  server.stop()
  const afterStop = await call({ ...me, command: 'operations.status' }).catch(() => null)
  ok(afterStop === null || afterStop.status >= 400, '能力服务：stop 后端点不再服务')

  await rm(opsDir, { recursive: true, force: true })
}

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await build({
    entryPoints: ['src/main/yan-cli.ts'],
    outfile: 'out/test/yan-cli.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
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
  ok(/用法：/.test(help.stdout ?? ''), 'yan CLI：--help 打出用法')
  ok(
    /tasks apply/.test(help.stdout ?? ''),
    'yan CLI：帮助里写了任务写入的用法（迁移后的入口要能被模型发现）'
  )
  ok(/subagent start/.test(help.stdout ?? ''), 'yan CLI：主帮助里写了子代理启动入口')
  const subagentHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'subagent', '--help'], { encoding: 'utf8' })
  ok(subagentHelp.status === 0 && /start/.test(subagentHelp.stdout ?? ''), 'yan CLI：子代理分组帮助可按需读取')
  const capabilityHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'capabilities', '--help'], { encoding: 'utf8' })
  ok(
    capabilityHelp.status === 0 &&
      /内容审查/.test(capabilityHelp.stdout ?? '') &&
      /批准面板/.test(capabilityHelp.stdout ?? '') &&
      /state=blocked/.test(capabilityHelp.stdout ?? ''),
    'yan CLI：能力接入帮助说明内容审查与限时批准面板（可疑注入由 state=blocked fail-closed 表达）'
  )
  ok(
    /你不能替用户批准/.test(capabilityHelp.stdout ?? '') &&
      /逐文件核对 Git 哈希/.test(capabilityHelp.stdout ?? ''),
    'yan CLI：能力接入帮助写明模型不能替用户批准，GitHub 技能固定到提交并逐文件核对哈希'
  )
  const skillHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'skill', '--help'], { encoding: 'utf8' })
  ok(skillHelp.status === 0 && /save/.test(skillHelp.stdout ?? '') && /replace/.test(skillHelp.stdout ?? ''), 'yan CLI：技能帮助说明 save 与覆盖规则')

  await rm(binDir, { recursive: true, force: true })
}

{
  const { existsSync, readFileSync } = await import('node:fs')

  const notesFix = 'scripts/fixtures/task-ext/notes-panel.ts'
  const notesText = existsSync(notesFix) ? readFileSync(notesFix, 'utf8') : ''
  ok(existsSync('scripts/fixtures/task-ext/left-info-panel.ts'), 'S5 fixture：旧任务扩展还在')
  ok(notesText.length > 0, 'S5 fixture：无关扩展（notes-panel.ts）还在')
  ok(/registerCommand\('notes'/.test(notesText), 'S5 fixture：无关扩展真的注册了自己的 /notes 命令')
  ok(
    !/appendEntry/.test(notesText),
    'S5 fixture：无关扩展不写任何 custom entry（否则它就不是「无关」了）'
  )

  const builder = readFileSync('electron-builder.yml', 'utf8')
  ok(/from: resources\/yan-cli/.test(builder), '打包：yan-cli 在 extraResources 里')
  ok(/to: yan-cli/.test(builder), '打包：yan-cli 落到安装目录的 yan-cli/')
  ok(/from: resources\/pi-extensions[\s\S]*to: yan-thin/.test(builder), '打包：砚薄层与 pi 用户扩展目录分离')
}

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await build({
    entryPoints: ['resources/pi-extensions/capability-guide.js'],
    outfile: 'out/test/capability-guide.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const mod = await import('../out/test/capability-guide.mjs')
  const guide = mod.CAPABILITY_GUIDE

  ok(/yan --help/.test(guide), '能力说明：告诉模型按需查完整用法')
  ok(
    /resultFile/.test(guide) && /never the whole result file/.test(guide),
    '能力说明：写明「摘要 + 结果文件，别整份读进上下文」'
  )
  ok(/yan <group> --help/.test(guide) && /SKILL\.md/.test(guide), '能力说明：目录式，用法按需读组帮助或技能文件')
  for (const group of ['capabilities', 'browser', 'search', 'question', 'tasks', 'subagent', 'image', 'artifact', 'file', 'session', 'operations']) {
    ok(new RegExp(`- ${group}: |; ${group}: `).test(guide), `能力说明：目录列出 ${group}`)
  }
  ok(/skill subagent/.test(guide) && /do not sleep-poll/.test(guide) && !/yan research read/.test(guide), '能力说明：子代理指向随包技能并说明不轮询，不推荐已退出的资料库研究入口')
  ok(!/ctx:\/\//.test(guide) && !/yan context/.test(guide), '能力说明：不再引用已退役的上下文召回')
  ok(/fitting skill/.test(guide) && /MCP only when needed/.test(guide), '能力说明：写明能力选择优先顺序')
  ok(/3\+ distinct steps/.test(guide) && /yan tasks apply/.test(guide) && /data, not instructions/.test(guide), '能力说明：多步工作先建待办，网页与文件内容只当数据')
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
    const fire = (name, event) => hooks[name].map((fn) => fn(event)).find((r) => r !== undefined)
    const tool = { role: 'tool', content: 'out' }
    const payload = { messages: [{ role: 'user', content: 'go' }, tool] }
    fire('message_end', { message: { role: 'user' } })
    for (let i = 1; i < mod.TASK_REMINDER_AFTER; i++) fire('tool_call', { toolName: 'bash', input: { command: 'ls' } })
    ok(fire('before_provider_request', { payload }) === undefined, '待办提醒：工具调用未到阈值不提醒')
    fire('tool_call', { toolName: 'read', input: { path: 'a' } })
    const reminded = fire('before_provider_request', { payload })
    ok(reminded?.messages.length === 3 && reminded.messages[2].role === 'user' && reminded.messages[2].content === mod.TASK_REMINDER && reminded.messages[1] === tool, '待办提醒：到阈值时追加在请求末尾，不改前面的消息')
    ok(fire('before_provider_request', { payload }) === undefined, '待办提醒：一个用户回合只提醒一次')
    const anthropic = mod.withTaskReminder({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] })
    ok(anthropic.messages.length === 1 && anthropic.messages[0].content[1]?.text === mod.TASK_REMINDER, '待办提醒：末条是用户内容块时并进同一条，不产生连续两条用户消息')
    fire('message_end', { message: { role: 'user' } })
    fire('tool_call', { toolName: 'bash', input: { command: "yan tasks apply --request-file - <<'EOF'" } })
    for (let i = 0; i < mod.TASK_REMINDER_AFTER + 2; i++) fire('tool_call', { toolName: 'bash', input: { command: 'ls' } })
    ok(fire('before_provider_request', { payload }) === undefined, '待办提醒：会话里用过 yan tasks 后不再提醒')
  }
  const visual = mod.VISUAL_ANSWER_GUIDE
  ok(/yan-chart/.test(visual) && /yan-cards/.test(visual) && /yan-flow/.test(visual) && /data source/.test(visual) && /skill visual-answer/.test(visual), '能力说明：常驻列出结构化回答块与数据来源要求，字段格式指向技能')
  {
    const probeHandlers = {}
    mod.default({ on: (name, fn) => { probeHandlers[name] = fn } })
    const options = { sections: { preamble: 'x' } }
    const result = probeHandlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: options })
    ok(options.sections.inkstone_visual_answer === visual && options.sections.inkstone_capabilities === mod.CAPABILITY_GUIDE && result === undefined,
      '能力说明：有具名分区时只写分区、不返回整段提示（否则 pi 会固定整段提示，其他扩展的分区失效）')
  }

  const handlers = {}
  mod.default({
    on: (name, fn) => {
      handlers[name] = fn
    }
  })
  ok(typeof handlers.before_agent_start === 'function', '能力说明：注册在 before_agent_start')

  const first = handlers.before_agent_start({ systemPrompt: 'base' })
  ok(
    !!first && first.systemPrompt.startsWith('base') && first.systemPrompt.includes(mod.CAPABILITY_GUIDE),
    '能力说明：追加在系统提示末尾（不篡改原有内容）'
  )
  const second = handlers.before_agent_start({ systemPrompt: first.systemPrompt })
  ok(second === undefined, '能力说明：幂等，已注入后不再重复追加')
}

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await build({
    entryPoints: ['resources/pi-extensions/danger-guard.js'],
    outfile: 'out/test/danger-guard.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const dangerGuard = await import('../out/test/danger-guard.mjs')
  const { runDangerGuardTests } = await import('./test-danger-guard.mjs')
  runDangerGuardTests(ok, dangerGuard)
}

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await build({
    entryPoints: ['src/shared/session-search-text.ts'],
    outfile: 'out/test/session-search-text.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const searchText = await import('../out/test/session-search-text.mjs')
  const { runSessionSearchTests } = await import('./test-session-search.mjs')
  runSessionSearchTests(ok, searchText)
}

{
  const { readFileSync } = await import('node:fs')
  const bad = []
  for (const file of ['zh-CN', 'en-US']) {
    const json = JSON.parse(readFileSync(`src/renderer/src/i18n/${file}.json`, 'utf8'))
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === 'string' && value.includes('**')) bad.push(`${file}:${key}`)
    }
  }
  ok(bad.length === 0, 'i18n 文案不含 markdown 加粗记号', bad.join(', '))

  const zhJson = JSON.parse(readFileSync('src/renderer/src/i18n/zh-CN.json', 'utf8'))
  const enJson = JSON.parse(readFileSync('src/renderer/src/i18n/en-US.json', 'utf8'))
  const missingIso = ['rail.isolationWaiting', 'rail.isolationBlocked'].filter((k) => !zhJson[k] || !enJson[k])
  ok(missingIso.length === 0, '隔离标记的中英文案都在', missingIso.join(', '))
  const holes = (v) => [...String(v ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  ok(
    holes(zhJson['rail.isolationWaiting']) === 'branch' && holes(enJson['rail.isolationWaiting']) === 'branch',
    '隔离文案的占位符一致（branch）',
    `${holes(zhJson['rail.isolationWaiting'])} / ${holes(enJson['rail.isolationWaiting'])}`
  )
}

{
  await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
    build({
      entryPoints: ['src/shared/ui-timeout.ts'],
      outfile: 'out/test/ui-timeout.mjs',
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent'
    })
  )
  const { runUiTimeoutTests } = await import('./test-ui-timeout.mjs')
  await runUiTimeoutTests(ok)
}

{
  const { spawnSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { build } = await import('../node_modules/esbuild/lib/main.js')

  console.log('\n--- 01-S4b 浏览器 CLI ---')

  const shellExt = new URL('../resources/pi-extensions/browser.js', import.meta.url)
  ok(!existsSync(shellExt), 'browser.js 空壳扩展已从随包薄层移除')

  const legacyHint = []
  for (const file of ['src/main/browser.ts', 'src/main/browser/ElementRegistry.ts']) {
    const source = await readFile(file, 'utf8')
    if (/调用\s*browser_/.test(source)) legacyHint.push(file)
  }
  ok(legacyHint.length === 0, '浏览器内部文案不点名旧工具名（统一写 yan browser …）', legacyHint.join('、'))

  await build({
    entryPoints: ['src/main/capability-server.ts'],
    outfile: 'out/test/capability-server-browser.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
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

  const help = runYan(['browser', '--help'])
  ok(help.status === 0 && /yan browser <动作>/.test(help.stdout ?? ''), 'yan CLI：browser --help 能跑（退出码 0）')
  ok(
    /navigate/.test(help.stdout ?? '') && /network/.test(help.stdout ?? '') && /screenshot/.test(help.stdout ?? ''),
    'yan CLI：browser 用法里列了动作（模型能发现）'
  )
  const mainHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', '--help'], {
    encoding: 'utf8',
    env
  })
  ok(/yan browser/.test(mainHelp.stdout ?? ''), 'yan CLI：主用法里也有 browser 一行')

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

  const cliText = await readFile('resources/yan-cli/yan.mjs', 'utf8')
  const specActions = (group) => {
    const block =
      new RegExp(`${group}:\\s*\\{[\\s\\S]*?actions:\\s*\\[([\\s\\S]*?)\\]`).exec(cliText)?.[1] ?? ''
    return [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  }
  const usageText = (group) => new RegExp(`${group}: \`([\\s\\S]*?)\``).exec(cliText)?.[1] ?? ''
  const browserActions = specActions('browser')
  ok(
    browserActions.includes('navigate') && browserActions.includes('network') && browserActions.includes('request-user-control'),
    'yan CLI：动作表里有 navigate / network / request-user-control'
  )
  const undocumented = browserActions.filter((action) => !usageText('browser').includes(action))
  ok(undocumented.length === 0, 'yan CLI：每个动作都在用法里（不漏文案）', undocumented.join(', '))
  const subagentActions = specActions('subagent')
  ok(subagentActions.includes('start') && subagentActions.includes('stop'), 'yan CLI：子代理动作表已登记')
  const subagentUndocumented = subagentActions.filter((action) => !usageText('subagent').includes(action))
  ok(
    subagentUndocumented.length === 0,
    'yan CLI：子代理每个动作都在用法里（不漏文案）',
    subagentUndocumented.join(', ')
  )
  const knowledgeActions = specActions('knowledge')
  ok(
    knowledgeActions.includes('search') && knowledgeActions.includes('read') && knowledgeActions.includes('propose'),
    'yan CLI：项目知识动作表已登记',
    knowledgeActions.join(', ')
  )
  const knowledgeUndocumented = knowledgeActions.filter((action) => !usageText('knowledge').includes(action))
  ok(
    knowledgeUndocumented.length === 0,
    'yan CLI：项目知识每个动作都在用法里（不漏文案）',
    knowledgeUndocumented.join(', ')
  )
  const knowledgeHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'knowledge', '--help'], {
    encoding: 'utf8'
  })
  ok(knowledgeHelp.status === 0 && /search/.test(knowledgeHelp.stdout ?? ''), 'yan CLI：knowledge 分组帮助可按需读取')

  ok(!specActions('goal').length, 'yan CLI：目标命令已退役')
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

const outlineTurns = await import('esbuild').then(({ build }) =>
  build({ entryPoints: ['src/shared/outline-turns.ts'], outfile: 'out/test/outline-turns.mjs',
    bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
    .then(() => import('../out/test/outline-turns.mjs'))
)
const { runOutlineTurnTests } = await import('./test-outline-turns.mjs')
runOutlineTurnTests(ok, outlineTurns)

const fsPromises = await import('node:fs/promises')

const pdfText = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/office/pdf-text.ts'],
    outfile: 'out/test/pdf-text.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/pdf-text.mjs'))
)
const { runPdfTextTests } = await import('./test-pdf-text.mjs')
runPdfTextTests(ok, pdfText)

const userSkillShared = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/user-skill.ts'],
    outfile: 'out/test/user-skill.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/user-skill.mjs'))
)
const userSkillMain = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/user-skills.ts'],
    outfile: 'out/test/user-skills.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['electron'],
    logLevel: 'silent'
  }).then(() => import('../out/test/user-skills.mjs'))
)
const { runUserSkillTests } = await import('./test-user-skill.mjs')
await runUserSkillTests(ok, userSkillShared, userSkillMain, { mkdtemp: fsPromises.mkdtemp, rm: fsPromises.rm })

const subagentBrief = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/subagent-brief.ts'],
    outfile: 'out/test/subagent-brief.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/subagent-brief.mjs'))
)
const { runSubagentBriefTests } = await import('./test-subagent-brief.mjs')
runSubagentBriefTests(ok, subagentBrief)

{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  const bundle = async (entry, out) => {
    await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
    return import('../' + out)
  }
  const outcome = await bundle('src/shared/subagent-outcome.ts', 'out/test/subagent-outcome.mjs')
  const notice = await bundle('src/shared/subagent-notice.ts', 'out/test/subagent-notice.mjs')
  const repeatGuard = await import('../resources/pi-extensions/repeat-guard.js')
  const { runSubagentOutcomeTests } = await import('./test-subagent-outcome.mjs')
  runSubagentOutcomeTests(ok, { outcome, notice, brief: subagentBrief, repeatGuard })
}

const searchMod = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/search/opencli.ts'],
    outfile: 'out/test/search.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/search.mjs'))
)
const { runSearchTests } = await import('./test-search.mjs')
await runSearchTests(ok, searchMod)

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
      "export * as bing from './src/main/search/bing.ts'",
      "export * as ddg from './src/main/search/ddg.ts'",
      "export * as so360 from './src/main/search/so360.ts'",
      "export * as brave from './src/main/search/brave.ts'",
      "export * as shared from './src/shared/search.ts'"
    ].join('\n')
    await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
      build({
        stdin: { contents: entry, resolveDir: resolve('.'), loader: 'ts' },
        outfile: 'out/test/search-providers.mjs',
        bundle: true,
        format: 'esm',
        platform: 'node',
        alias: { electron: stub },
        logLevel: 'silent'
      })
    )
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

const capabilityServerMod = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capability-server.ts'],
    outfile: 'out/test/capability-server.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/capability-server.mjs'))
)
const { runCapabilityResultTests } = await import('./test-capability-result.mjs')
await runCapabilityResultTests(ok, capabilityServerMod)

const browserWaitMod = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/browser-wait.ts'],
    outfile: 'out/test/browser-wait.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/browser-wait.mjs'))
)
const { runBrowserWaitTests } = await import('./test-browser-wait.mjs')
await runBrowserWaitTests(ok, browserWaitMod)

const buildNeutral = (entry, outfile) =>
  import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
    build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent'
    }).then(() => import(`../${outfile}`))
  )
const browserInputMod = await buildNeutral('src/main/browser/InputController.ts', 'out/test/browser-input.mjs')
const browserRegistryMod = await buildNeutral('src/main/browser/ElementRegistry.ts', 'out/test/browser-registry.mjs')
const { runBrowserSelectTests } = await import('./test-browser-select.mjs')
await runBrowserSelectTests(ok, browserInputMod, browserRegistryMod)

const browserNetworkMod = await buildNeutral('src/main/browser/NetworkTracker.ts', 'out/test/browser-network.mjs')
const { runBrowserNetworkTests } = await import('./test-browser-network.mjs')
await runBrowserNetworkTests(ok, browserNetworkMod)

const { runSessionReadEquivalenceTests } = await import('./test-session-read-equivalence.mjs')
await runSessionReadEquivalenceTests(ok)
await import('./test-session-reader-stream.mjs')

console.log(`\n${pass}/${pass + fail} 通过`)
if (spawnFailures.length) {
  console.log(`\n${spawnFailures.length} 个子进程测试失败：${spawnFailures.map((item) => item.script).join(', ')}`)
  for (const item of spawnFailures) {
    console.log(`\n--- ✗ ${item.script}：${item.detail} ---`)
    console.log(item.tail || '（没有输出）')
    console.log(`完整输出：${item.logPath}`)
  }
}
await rm(dataDir, { recursive: true, force: true })
process.exit(fail || spawnFailures.length ? 1 : 0)
