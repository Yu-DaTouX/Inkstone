import './lib/stdio-guard.mjs'
import { defaultLiveCases, validateSyntheticSelection, syntheticEnvironment } from './lib/live-synthetic-isolation.mjs'
import { spawn, execFileSync } from 'node:child_process'
import vm from 'node:vm'
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  cpSync,
  existsSync,
  appendFileSync,
  symlinkSync,
  utimesSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SYNTHETIC_ONLY = process.env.YAN_TEST_SYNTHETIC_ONLY === '1'
const TEST_MODEL = process.env.YAN_TEST_MODEL || (SYNTHETIC_ONLY ? 'openai/gpt-4o-mini' : 'commandcode/deepseek/deepseek-v4.1-flash')

const electronBin = createRequire(import.meta.url)('electron')

const TEST_VISION_MODEL =
  process.env.YAN_TEST_VISION_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash'

const USE_LOCAL_TEST_MODEL = TEST_MODEL.startsWith('local/')
function modelForCase(fallback) {
  if (USE_LOCAL_TEST_MODEL && fallback && !/nonexistent|route-probe/i.test(fallback)) return TEST_MODEL
  return fallback ?? TEST_MODEL
}

const CASES = {
  arrivaldom: { probe: 'scripts/probe/stream-arrival-dom.js', delay: 9000, cost: 0 },
  bundlereal: { probe: 'scripts/probe/bundle-real-model.js', fixture: true, fixtureSub: 'repo', visible: true, delay: 9000, cost: 3, budget: 260000, env: { YAN_TEST_MODEL_MAX_TOKENS: '4096' } },
  turns: { probe: 'scripts/probe/turns.js', delay: 24000, cost: 0 },
  runprogress: { probe: 'scripts/probe/run-progress.js', delay: 9000, cost: 0 },
  library: { probe: 'scripts/probe/library.js', delay: 9000, cost: 0 },
  subagentbrief: { probe: 'scripts/probe/subagent-brief.js', delay: 12000, cost: 0 },
  customapi: { probe: 'scripts/probe/custom-api.js', delay: 9000, cost: 0 },
  customapie2e: { probe: 'scripts/probe/custom-api-e2e.js', delay: 12000, cost: 2 },
  live: { probe: 'scripts/probe/live.js', delay: 9000, cost: 0 },
  remoteroutes: {
    probe: 'scripts/probe/remote-routes.js',
    delay: 15000,
    budget: 120000,
    cost: 0,
    driver: driveRemoteRoutes,
    afterExit: 'remoteRoutes'
  },
  reasoning: { probe: 'scripts/probe/reasoning.js', delay: 9000, cost: 0 },
  capabilityload: { probe: 'scripts/probe/capabilityload.js', delay: 9000, cost: 0 },
  capsettings: { probe: 'scripts/probe/capabilities-tab.js', delay: 12000, cost: 0, budget: 150000 },
  codemodesetting: { probe: 'scripts/probe/codemode-setting.js', delay: 9000, cost: 0 },
  modelnotready: { probe: 'scripts/probe/modelnotready.js', delay: 9000, cost: 0 },
  hotkeys: {
    probe: 'scripts/probe/hotkeys.js',
    delay: 9000,
    cost: 0,
    keys: 'ctrl+shift+p,ctrl+p,shift+tab'
  },
  dialog: {
    probe: 'scripts/probe/dialog.js',
    delay: 20000,
    cost: 0,
    keys: 'shift+tab,shift+tab,shift+tab,shift+tab'
  },
  toolrow: { probe: 'scripts/probe/toolrow.js', delay: 10000, cost: 0 },
  toolimages: { probe: 'scripts/probe/tool-images.js', delay: 10000, cost: 0 },
  trash: { probe: 'scripts/probe/trash.js', delay: 10000, cost: 0 },
  fileref: { probe: 'scripts/probe/fileref.js', delay: 10000, cost: 0 },
  linkpreview: { probe: 'scripts/probe/linkpreview.js', delay: 11000, cost: 0 },
  detail: { probe: 'scripts/probe/detail.js', delay: 10000, cost: 0 },
  permissions: { probe: 'scripts/probe/permissions.js', delay: 9000, cost: 0 },
  modelmenu: {
    probe: 'scripts/probe/modelmenu.js',
    delay: 9000,
    cost: 0,
    wins: ['1440x900', '940x640']
  },
  subagent: { probe: 'scripts/probe/subagent.js', delay: 12000, cost: 1, budget: 240000 },
  subagentview: { probe: 'scripts/probe/subagent-view.js', delay: 10000, cost: 0 },
  subagentlocal: {
    probe: 'scripts/probe/subagent.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    budget: 240000,
    cost: 0
  },
  subagentpair: {
    probe: 'scripts/probe/subagentpair.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 14000,
    budget: 240000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    afterExit: 'subagentArchive'
  },
  subagentfail: {
    probe: 'scripts/probe/subagent-fail.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 14000,
    budget: 300000,
    cost: 0,
    model: 'deepseek/deepseek-nonexistent',
    afterExit: 'subagentFail'
  },
  sessionab: {
    probe: 'scripts/probe/sessionab.js',
    fixture: true,
    abSessions: true,
    delay: 14000,
    budget: 300000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    afterExit: 'sessionabArchive'
  },
  askbackground: {
    probe: 'scripts/probe/ask-background.js',
    fixture: true,
    abSessions: true,
    delay: 12000,
    budget: 200000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },
  runnerfailed: { probe: 'scripts/probe/runner-failed.js', fixture: true, fixtureSub: 'repo', delay: 9000, budget: 120000, cost: 0, brokenPi: true },
  crash: { probe: 'scripts/probe/crash.js', delay: 9000, cost: 0 },
  atrefsend: {
    probe: 'scripts/probe/atrefsend.js',
    fixture: true,
    delay: 12000,
    cost: 1,
    model: 'commandcode/longcat-2.0:free',
    afterExit: 'atrefsendArchive'
  },
  modelswitch: { probe: 'scripts/probe/modelswitch.js', delay: 12000, cost: 0 },
  density: { probe: 'scripts/probe/density.js', delay: 10000, cost: 0 },
  railsearch: { probe: 'scripts/probe/railsearch.js', delay: 11000, cost: 0 },
  perf: { probe: 'scripts/probe/perf.js', delay: 16000, cost: 0, visible: true },
  bootspeed: { probe: 'scripts/probe/bootspeed.js', delay: 1500, cost: 0, visible: true },
  switchspeed: { probe: 'scripts/probe/switchspeed.js', delay: 1000, cost: 0, visible: true, budget: 120000 },
  hold: { probe: 'scripts/probe/hold.js', delay: 500, cost: 0, visible: true, budget: 150000 },
  deltas: { probe: 'scripts/probe/deltas.js', delay: 12000, cost: 0 },
  layoutdiag: { probe: 'scripts/probe/layoutdiag.js', delay: 12000, cost: 0 },
  virtualdiag: { probe: 'scripts/probe/virtualdiag.js', delay: 14000, cost: 0 },
  sendkey: { probe: 'scripts/probe/sendkey.js', delay: 9000, cost: 0 },
  sendtail: { probe: 'scripts/probe/send-tail.js', delay: 9000, cost: 0 },
  updatenotice: { probe: 'scripts/probe/update-notice.js', delay: 9000, cost: 0 },
  pending: { probe: 'scripts/probe/pending.js', delay: 9000, cost: 0 },
  pendingreal: { probe: 'scripts/probe/pending-real.js', delay: 15000, cost: 1 },
  zoom: {
    probe: 'scripts/probe/zoom.js',
    delay: 7000,
    cost: 0,
    keys: 'ctrl+=,ctrl+=,ctrl+-,ctrl+0'
  },
  branch: { probe: 'scripts/probe/branch.js', delay: 10000, cost: 0 },
  topbar: { probe: 'scripts/probe/topbar.js', delay: 9000, cost: 0 },
  'v3-shell': {
    probe: 'scripts/probe/v3-shell.js', delay: 9000, cost: 0,
    keys: 'ctrl+k,escape,enter', keysDelay: 11000, env: { YAN_UI: 'v3' }
  },
  'v3-user-polish': { probe: 'scripts/probe/v3-user-polish.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-user-followup': { probe: 'scripts/probe/v3-user-followup.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-ascii-once': {
    probe: 'scripts/probe/v3-ascii-once.js', delay: 9000, cost: 0, budget: 60000,
    keys: 'space', keysDelay: 15000, env: { YAN_UI: 'v3' }
  },
  'v3-todos': {
    probe: 'scripts/probe/v3-todos.js', delay: 9000, cost: 0, budget: 90000,
    keys: 'ctrl+b', keysDelay: 20000, env: { YAN_UI: 'v3' },
    afterExit: 'taskFixtureReadonly', readonlySession: 'yan-todo-fixture'
  },
  'v3-composer': { probe: 'scripts/probe/v3-composer.js', delay: 9000, cost: 0, budget: 90000, env: { YAN_UI: 'v3' } },
  'v3-sendkey': { probe: 'scripts/probe/v3-sendkey.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-completion': { probe: 'scripts/probe/v3-completion.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-projectmenu': { probe: 'scripts/probe/v3-projectmenu.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-logsquota': { probe: 'scripts/probe/v3-logsquota.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-delegate': { probe: 'scripts/probe/v3-delegate.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-voicecu': { probe: 'scripts/probe/v3-voicecu.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-queuestack': { probe: 'scripts/probe/v3-queuestack.js', delay: 9000, cost: 0, env: { YAN_UI: 'v3' } },
  'v3-real-send': { probe: 'scripts/probe/v3-real-send.js', fixture: true, delay: 12000, cost: 1, budget: 300000, env: { YAN_UI: 'v3' } },
  'v3-real-todos': { probe: 'scripts/probe/v3-real-todos.js', fixture: true, delay: 12000, cost: 1, budget: 360000, env: { YAN_UI: 'v3' } },
  'v3-real-review': { probe: 'scripts/probe/v3-real-review.js', fixture: true, fixtureSub: 'review', delay: 12000, cost: 1, budget: 360000, env: { YAN_UI: 'v3' } },
  outlinepos: { probe: 'scripts/probe/outlinepos.js', delay: 9000, cost: 0, visible: true },
  narrow: {
    probe: 'scripts/probe/narrow.js',
    delay: 9000,
    cost: 0,
    wins: ['1456x1000', '1002x700', '940x700']
  },
  righttabs: {
    probe: 'scripts/probe/righttabs.js',
    delay: 9000,
    cost: 0,
    wins: ['1456x900', '940x700']
  },
  narrowscan: {
    probe: 'scripts/probe/narrowscan.js',
    delay: 9000,
    cost: 0,
    wins: ['1600x1000', '1280x860', '1100x760', '1000x700', '940x640']
  },
  todonew: { probe: 'scripts/probe/todonew.js', delay: 9000, cost: 0 },
  rename: { probe: 'scripts/probe/rename.js', delay: 9000, cost: 0 },
  grouprename: { probe: 'scripts/probe/grouprename.js', delay: 9000, cost: 0, fixture: true },
  projectremove: { probe: 'scripts/probe/projectremove.js', delay: 9000, cost: 0, fixture: true },
  projectdirectory: { probe: 'scripts/probe/project-directory.js', delay: 9000, cost: 0, fixture: true },
  railreorder: { probe: 'scripts/probe/rail-reorder.js', delay: 10000, cost: 0, budget: 150000, fixture: true },
  projectlimit: { probe: 'scripts/probe/projectlimit.js', delay: 9000, cost: 0 },
  railtitle: { probe: 'scripts/probe/railtitle.js', delay: 9000, cost: 0 },
  railmini: { probe: 'scripts/probe/railmini.js', delay: 9000, cost: 0 },
  railpeek: { probe: 'scripts/probe/railpeek.js', delay: 9000, cost: 0 },
  switcher: { probe: 'scripts/probe/switcher.js', delay: 9000, cost: 0 },
  rewind: { probe: 'scripts/probe/rewind.js', delay: 9000, cost: 0 },
  plusmenu: { probe: 'scripts/probe/plus-menu.js', delay: 15000, cost: 0, budget: 120000 },
  context: { probe: 'scripts/probe/context.js', delay: 9000, cost: 0 },
  contextinspect: { probe: 'scripts/probe/context-inspect.js', delay: 9000, cost: 1, budget: 60000 },
  contextactions: { probe: 'scripts/probe/contextactions.js', delay: 9000, cost: 0 },
  compactionstatus: {
    probe: 'scripts/probe/compaction-status.js',
    delay: 9000,
    cost: 1,
    budget: 180000,
    fixture: true,
    fixtureSub: 'compact',
    piSettings: { compaction: { enabled: true, reserveTokens: 900000, keepRecentTokens: 1 } }
  },
  contextswitchguard: {
    probe: 'scripts/probe/context-switch-guard.js',
    delay: 10000,
    cost: 0,
    contextGuardSeed: true,
    budget: 90000,
    env: { YAN_CONTEXT_POLICY: '{"workingSetCap":100,"emergencyRatio":0.001}' }
  },
  contextwindow1m: {
    probe: 'scripts/probe/context-window-1m.js',
    delay: 12000,
    cost: 1,
    budget: 900000,
    contextExtLog: true,
    model: 'commandcode/claude-sonnet-5'
  },
  thinkinglevels: { probe: 'scripts/probe/thinking-levels.js', delay: 14000, cost: 0, needsCredentials: true },
  queuestack: { probe: 'scripts/probe/queuestack.js', delay: 9000, cost: 0 },
  logs: { probe: 'scripts/probe/logs.js', delay: 9000, cost: 0 },
  slashcmd: { probe: 'scripts/probe/slashcmd.js', delay: 9000, cost: 0 },
  quota: { probe: 'scripts/probe/quota.js', delay: 10000, cost: 0, budget: 120000, needsCredentials: true },
  resize: { probe: 'scripts/probe/resize.js', delay: 9000, cost: 0 },
  fsedge: { probe: 'scripts/probe/fs-edge.js', delay: 11000, cost: 0, fixture: true, budget: 150000 },
  atpathedge: { probe: 'scripts/probe/at-path-edge.js', delay: 11000, cost: 0, fixture: true },
  projectswitch: { probe: 'scripts/probe/project-switch.js', delay: 10000, cost: 0, fixture: true, budget: 180000, projectSessions: true },
  projectopened: {
    probe: 'scripts/probe/project-opened.js',
    fixture: true,
    projectSessions: true,
    openedSessions: true,
    delay: 10000,
    budget: 180000,
    cost: 0,
    afterExit: 'projectOpenedLayout'
  },
  tiledrag: { probe: 'scripts/probe/tile-drag-width.js', delay: 9000, cost: 0 },
  workspacechanges: { probe: 'scripts/probe/workspace-changes.js', delay: 10000, cost: 0, fixture: true, fixtureSub: 'repo', budget: 180000, projectPeers: true },
  gitwrite: {
    probe: 'scripts/probe/git-write.js',
    fixture: true,
    fixtureSub: 'write',
    delay: 13000,
    budget: 240000,
    cost: 0,
    afterExit: 'gitWriteApplied'
  },
  sourcelink: {
    probe: 'scripts/probe/source-locate.js',
    fixture: true,
    fixtureSub: 'review',
    abSessions: true,
    delay: 11000,
    budget: 150000,
    cost: 0,
    afterExit: 'sourceLocateLinked'
  },
  sourcelinklive: {
    probe: 'scripts/probe/source-locate-send.js',
    fixture: true,
    delay: 9000,
    budget: 200000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    afterExit: 'sourceLocateLinked'
  },
  pkgs: { probe: 'scripts/probe/packages.js', fixture: true, fixtureSub: 'pkgs', delay: 12000, budget: 300000, cost: 0 },
  packagescope: { probe: 'scripts/probe/package-scope.js', fixture: true, fixtureSub: 'pkgs', delay: 9000, budget: 180000, cost: 0 },
  fs: { probe: 'scripts/probe/fs.js', delay: 9000, cost: 0 },
  motion: { probe: 'scripts/probe/motion.js', delay: 9000, cost: 0 },
  authEnv: {
    probe: 'scripts/probe/auth-env.js',
    delay: 9000,
    cost: 0,
    env: { OPENAI_API_KEY: 'sk-probe-dummy-not-a-real-key' }
  },
  auth: { probe: 'scripts/probe/auth.js', delay: 9000, cost: 0 },
  atPath: { probe: 'scripts/probe/at-path.js', delay: 9000, cost: 0 },
  titlebar: { probe: 'scripts/probe/titlebar.js', delay: 9000, cost: 0 },
  browser: { probe: 'scripts/probe/browser.js', delay: 9000, cost: 0 },
  externalchrome: {
    probe: 'scripts/probe/external-chrome.js',
    delay: 9000,
    cost: 0,
    env: { YAN_CHROME_HEADLESS: '1', YAN_CHROME_SYNC: '0' }
  },
  browserboundary: {
    probe: 'scripts/probe/browser-boundary.js',
    delay: 9000,
    cost: 0,
    budget: 180000,
    usesBoundaryServer: true,
    boundaryCookieCheck: true,
    afterExit: 'browserBoundaryDownloads',
    env: { YAN_CHROME_HEADLESS: '1', YAN_CHROME_SYNC: '0' }
  },
  browserframeboundary: {
    probe: 'scripts/probe/browser-boundary.js',
    probePrefix: 'window.__yanBrowserFrameNetworkOnly = true;\n',
    delay: 9000,
    cost: 0,
    usesBoundaryServer: true,
    budget: 90000
  },
  browserframes: {
    probe: 'scripts/probe/browser-frames.js',
    delay: 9000,
    cost: 0,
    usesBoundaryServer: true,
    budget: 90000
  },
  searchopen: { probe: 'scripts/probe/search-open.js', delay: 12000, cost: 0, budget: 180000 },
  browserreal: { probe: 'scripts/probe/browser-real-sites.js', delay: 9000, cost: 0, budget: 240000 },
  light: { probe: 'scripts/probe/light.js', delay: 9000, cost: 0 },
  composersize: { probe: 'scripts/probe/composer-size.js', delay: 9000, cost: 0, wins: ['1440x900', '1100x700', '940x640', '900x520'] },
  questionshot: { probe: 'scripts/probe/question-shot.js', delay: 9000, cost: 0 },
  modelscroll: { probe: 'scripts/probe/modelscroll.js', delay: 9000, cost: 0 },
  gitinstall: { probe: 'scripts/probe/gitinstall.js', delay: 9000, cost: 0, freshDesktop: true, needsDownload: true, budget: 300000 },
  restartempty: { probe: 'scripts/probe/restart-empty.js', delay: 9000, cost: 0 },
  nogit: { probe: 'scripts/probe/nogit.js', delay: 9000, cost: 0, freshDesktop: true },
  newuser: { probe: 'scripts/probe/newuser.js', delay: 9000, cost: 0, freshDesktop: true },
  onboarding: {
    probe: 'scripts/probe/onboarding.js',
    delay: 9000,
    cost: 0,
    wins: ['1440x900', '940x640']
  },
  wizard: {
    probe: 'scripts/probe/wizard.js',
    delay: 9000,
    cost: 0,
    freshDesktop: true,
    wins: ['1440x900', '940x640']
  },
  features: { probe: 'scripts/probe/features.js', delay: 9000, cost: 0 },
  outline: { probe: 'scripts/probe/outline.js', delay: 9000, cost: 0 },
  iconstate: { probe: 'scripts/probe/iconstate.js', delay: 9000, cost: 0 },
  controlstates: { probe: 'scripts/probe/controlstates.js', delay: 9000, cost: 0, fixture: true },
  iconsurface: { probe: 'scripts/probe/iconsurface.js', delay: 9000, cost: 0, fixture: true },
  layout: { probe: 'scripts/probe/layout.js', delay: 9000, cost: 0 },
  tokens: { probe: 'scripts/probe/tokens.js', delay: 9000, cost: 1 },
  title: {
    probe: 'scripts/probe/title.js',
    delay: 12000,
    budget: 260000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },
  language: {
    probe: 'scripts/probe/language.js',
    delay: 14000,
    budget: 300000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    env: { YAN_LANG_EXT_LOG: join(tmpdir(), 'lang-ext.log') }
  },
  settings: { probe: 'scripts/probe/settings.js', delay: 9000, cost: 0 },
  sound: { probe: 'scripts/probe/sound.js', delay: 9000, cost: 0 },
  toolgroup: { probe: 'scripts/probe/toolgroup.js', delay: 9000, cost: 0 },
  terminal: { probe: 'scripts/probe/terminal.js', delay: 9000, cost: 0 },
  terminalsurface: { probe: 'scripts/probe/terminal-surface.js', delay: 11000, cost: 0, budget: 120000 },
  streamwidth: { probe: 'scripts/probe/streamwidth.js', delay: 9000, cost: 0 },
  working: { probe: 'scripts/probe/working.js', delay: 9000, cost: 0 },
  conn: { probe: 'scripts/probe/conn.js', delay: 9000, cost: 1 },
  todos: {
    probe: 'scripts/probe/todos.js',
    delay: 9000,
    cost: 0,
    afterExit: 'taskFixtureReadonly',
    readonlySession: 'yan-todo-fixture'
  },
  taskext: {
    probe: 'scripts/probe/taskext.js',
    delay: 12000,
    cost: 0,
    afterExit: 'taskFixtureReadonly',
    readonlySession: 'yan-todo-fixture'
  },
  virtual: { probe: 'scripts/probe/virtual.js', delay: 9000, cost: 0, visible: true },
  splitreal: { probe: 'scripts/probe/split-real.js', delay: 12000, cost: 0, visible: true },
  splitdrop: { probe: 'scripts/probe/split-drop.js', delay: 9000, cost: 0, visible: true },
  splitdeferred: { probe: 'scripts/probe/split-deferred.js', delay: 12000, cost: 0, visible: true },
  splitfive: { probe: 'scripts/probe/split-five.js', delay: 9000, cost: 0, visible: true },
  splitvirtual: { probe: 'scripts/probe/split-virtual.js', delay: 9000, cost: 0, visible: true },
  sessions: { probe: 'scripts/probe/sessions.js', delay: 9000, cost: 0 },
  historyswitch: { probe: 'scripts/probe/history-switch.js', delay: 9000, cost: 0 },
  sessionlayout: { probe: 'scripts/probe/sessionlayout.js', delay: 9000, cost: 0 },
  tray: { probe: 'scripts/probe/tray.js', delay: 9000, cost: 0, visible: true, env: { YAN_EXIT_CHOICE: 'cancel' } },
  exitsave: { probe: 'scripts/probe/exit-save.js', delay: 9000, cost: 0, afterExit: 'exitSnapshot', env: { YAN_EXIT_CHOICE: 'save' } },
  exitinterrupt: { probe: 'scripts/probe/exit-interrupt.js', delay: 9000, cost: 0, afterExit: 'exitSnapshot', env: { YAN_EXIT_CHOICE: 'interrupt' } },
  sessionrunners: { probe: 'scripts/probe/sessionrunners.js', delay: 9000, cost: 0 },
  runnerselect: { probe: 'scripts/probe/runnerselect.js', delay: 12000, cost: 0 },
  latds: { probe: 'scripts/probe/send-latency.js', delay: 9000, cost: 1, budget: 300000, model: 'commandcode/deepseek/deepseek-v4.1-flash' },
  latluna: { probe: 'scripts/probe/send-latency.js', delay: 9000, cost: 1, budget: 300000, model: 'openai-codex/gpt-6-luna' },
  lathaiku: { probe: 'scripts/probe/send-latency.js', delay: 9000, cost: 1, budget: 300000, model: 'claude-bridge/haiku' },
  e2e: { probe: 'scripts/probe/e2e.js', delay: 9000, cost: 1, budget: 200000 },
  capability: { probe: 'scripts/probe/capability.js', delay: 12000, cost: 1, budget: 180000 },
  skillcleanup: { probe: 'scripts/probe/skill-cleanup.js', delay: 12000, cost: 1, budget: 300000 },
  repeatguardlive: { probe: 'scripts/probe/repeat-guard-live.js', delay: 12000, cost: 1, budget: 360000 },
  subagentmodel: {
    probe: 'scripts/probe/subagent-model.js',
    delay: 12000,
    cost: 1,
    budget: 260000,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },
  knowledgecli: {
    probe: 'scripts/probe/knowledge-cli.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    budget: 360000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    knowledgeSeed: true,
    afterExit: 'knowledgeCli'
  },
  taskcli: {
    probe: 'scripts/probe/taskcli.js',
    fixture: true,
    delay: 12000,
    cost: 1,
    budget: 300000,
    afterExit: 'taskCliLog'
  },
  taskplan: {
    probe: 'scripts/probe/taskplan.js',
    fixture: true,
    delay: 12000,
    cost: 1,
    budget: 420000,
    afterExit: 'taskPlanMultiStep'
  },
  ask: {
    probe: 'scripts/probe/ask.js',
    delay: 9000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    questionExtLog: true,
    afterExit: 'questionModeLog'
  },
  questioncli: { probe: 'scripts/probe/question-cli.js', delay: 9000, cost: 0, budget: 180000 },
  skillapprove: { probe: 'scripts/probe/skill-approve.js', delay: 9000, cost: 0, budget: 320000 },
  imgedit: { probe: 'scripts/probe/image-edit.js', delay: 12000, cost: 1, fixture: true, budget: 420000, model: 'commandcode/deepseek/deepseek-v4.1-flash' },
  image: { probe: 'scripts/probe/image.js', delay: 9000, cost: 1, model: TEST_VISION_MODEL },
  queue: { probe: 'scripts/probe/queue.js', delay: 9000, cost: 1 },
  queuebusy: { probe: 'scripts/probe/queue-busy.js', delay: 9000, cost: 1 },
  queueretract: { probe: 'scripts/probe/queue-retract.js', delay: 9000, cost: 0 },
  browsercli: {
    probe: 'scripts/probe/browser-cli.js',
    delay: 10000,
    cost: 0,
    fixture: true,
    budget: 240000
  },
  browserclimodel: {
    probe: 'scripts/probe/browser-cli-model.js',
    delay: 10000,
    cost: 1,
    budget: 260000,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },

  capsearch: {
    probe: 'scripts/probe/capability-search-model.js',
    delay: 10000,
    cost: 1,
    budget: 260000,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },

  capmcp: {
    probe: 'scripts/probe/mcp-search-model.js',
    delay: 10000,
    cost: 1,
    budget: 260000,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },

  discnet: { probe: 'scripts/probe/discovery-cli.js', delay: 9000, cost: 0 },

  skilldirnet: {
    probe: 'scripts/probe/skill-directory.js',
    delay: 12000,
    cost: 0,
    env: { YAN_SKILL_DIRECTORY_URL: 'https://api.skillmd.com/v1/search' }
  },

  capcli: { probe: 'scripts/probe/capability-cli.js', delay: 9000, cost: 0 },

  mcpcli: { probe: 'scripts/probe/mcp-cli.js', delay: 9000, cost: 0 },

  sourcecap: { probe: 'scripts/probe/source-capability.js', delay: 9000, cost: 0 },

  mcpregister: { probe: 'scripts/probe/mcp-register.js', delay: 9000, cost: 0, usesMcpRegisterFixture: true },

  turnfooter: { probe: 'scripts/probe/turn-footer.js', delay: 10000, cost: 0 },

  turnfooterlive: {
    probe: 'scripts/probe/turn-footer-live.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    budget: 240000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },

  overlayblockers: { probe: 'scripts/probe/overlayblockers.js', delay: 10000, cost: 0 },


  settingstabs: { probe: 'scripts/probe/settingstabs.js', delay: 10000, cost: 0 },
  remoteaccess: { probe: 'scripts/probe/remote-access.js', delay: 10000, cost: 0 },

  tilerestart: {
    probe: 'scripts/probe/tile-restart.js',
    restart: { probe: 'scripts/probe/tile-restart-restart.js', delay: 10000, cost: 0 },
    delay: 10000,
    cost: 0
  },

  contextmenu: { probe: 'scripts/probe/contextmenu.js', delay: 10000, cost: 0 },

  sessionmenuclick: { probe: 'scripts/probe/sessionmenuclick.js', delay: 9000, cost: 0 },

  sessionmenudupe: { probe: 'scripts/probe/sessionmenudupe.js', delay: 9000, cost: 0 },

  filelink: {
    probe: 'scripts/probe/filelink.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 10000,
    cost: 0
  },
  filestale: {
    probe: 'scripts/probe/file-stale.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 10000,
    budget: 60000,
    cost: 0,
    driver: driveFilePreviewMutation
  },

  compactionview: {
    probe: 'scripts/probe/compaction-view.js',
    delay: 10000,
    cost: 0
  },

  usageagg: {
    probe: 'scripts/probe/usage-agg.js',
    delay: 10000,
    cost: 0
  },

  turnrestore: {
    probe: 'scripts/probe/turn-timing-store-live.js',
    delay: 12000,
    budget: 300000,
    cost: 1,
    fixture: true,
    fixtureSub: 'repo',
    contextExtLog: true,
    afterExit: 'turnTimingPersisted'
  },
  turntimingisolation: {
    probe: 'scripts/probe/turn-timing-isolation.js',
    delay: 12000,
    budget: 180000,
    cost: 0,
    fixture: true,
    abSessions: true,
    afterExit: 'turnTimingIsolation'
  },
  turntimingkill: {
    probe: 'scripts/probe/turn-timing-hardkill.js',
    delay: 12000,
    budget: 90000,
    cost: 0,
    fixture: true,
    fixtureSub: 'repo',
    hardKillAfterIntermediateTiming: true,
    restart: { probe: 'scripts/probe/turn-timing-hardkill-restart.js', delay: 12000, budget: 120000 },
    afterExit: 'turnTimingHardKill',
    afterExitOnFailure: true
  },
  turninterrupted: {
    probe: 'scripts/probe/turn-timing-store-live.js',
    delay: 12000,
    budget: 300000,
    cost: 1,
    fixture: true,
    fixtureSub: 'repo',
    restart: { probe: 'scripts/probe/turn-timing-interrupted.js', delay: 12000, budget: 120000 },
    seedBeforeRestart: 'interruptedSnapshot',
    afterExit: 'turnTimingInterrupted'
  },
}

const TS = (offsetSec = 0) => new Date(Date.now() - offsetSec * 1000).toISOString()

const LONG_NAME = '一个非常长的文件名用来验证窄栏下的省略显示-0123456789-abcdefghij-中文结尾.md'

function denyDirRead(dir, user = process.env.USERNAME) {
  if (!user) return false
  try {
    execFileSync('icacls', [dir, '/deny', `${user}:(RD)`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function allowDirRead(dir, user = process.env.USERNAME) {
  if (!user) return
  try {
    execFileSync('icacls', [dir, '/remove:d', user], { stdio: 'ignore' })
  } catch {
  }
}

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makePng(size, rgb) {
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff
    for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    const off = y * stride
    raw[off] = 0
    for (let x = 0; x < size; x += 1) {
      raw[off + 1 + x * 3] = rgb[0]
      raw[off + 2 + x * 3] = rgb[1]
      raw[off + 3 + x * 3] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function buildFixtureProject(base) {
  const dir = join(base, 'fixture-project')
  allowDirRead(join(dir, 'noperm'))
  rmSync(dir, { recursive: true, force: true })
  const mk = (...parts) => mkdirSync(join(dir, ...parts), { recursive: true })
  const put = (rel, text) => writeFileSync(join(dir, rel), text, 'utf8')

  mk()
  for (let i = 1; i <= 8; i++) mk('probe-projects', `p${i}`)
  put('README.md', '# fixture project\n\n合成项目，只用于边界场景。\n')
  writeFileSync(join(dir, 'imgsrc.png'), makePng(64, [32, 96, 200]))
  mk('empty')
  mk('deep', 'a', 'b', 'c', 'd', 'e')
  put(join('deep', 'a', 'b', 'c', 'd', 'e', 'f.txt'), 'deep\n')
  mk('dup', 'one')
  mk('dup', 'two')
  put(join('dup', 'one', 'same.ts'), 'export const one = 1\n')
  put(join('dup', 'two', 'same.ts'), 'export const two = 2\n')
  mk('big')
  for (let i = 1; i <= 60; i += 1) {
    put(join('big', `f${String(i).padStart(3, '0')}.txt`), `${i}\n`)
  }
  mk('uni', '中文 目录')
  put(join('uni', '中文 目录', '文件 名.ts'), 'export const 中文 = 1\n')
  put('notadir.txt', 'not a directory\n')

  mk('compact', '.pi')
  put(
    join('compact', '.pi', 'settings.json'),
    JSON.stringify({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 1000 } }, null, 2)
  )
  put(join('compact', 'README.md'), '# compact cwd\n\nN21-2 的项目级设置边界。\n')

  mk('noperm')
  put(join('noperm', 'secret.txt'), 'no permission\n')
  const noPermDenied = denyDirRead(join(dir, 'noperm'))

  put(LONG_NAME, 'long name\n')

  mk('other')
  put(join('other', 'README.md'), '# other cwd\n\nN12 用的第二个工作目录。\n')
  try {
    execFileSync('git', ['init', '-q'], { cwd: join(dir, 'other'), stdio: 'ignore' })
  } catch {
  }

  const repo = join(dir, 'repo')
  mk('repo')
  put(join('repo', 'README.md'), '# fixture repo\n\nLINE-BASE: 初始内容\n')
  put(
    join('repo', 'big.txt'),
    Array.from({ length: 5000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')}`).join('\n') + '\n'
  )
  mk('repo', 'docs')
  put(join('repo', 'docs', 'a.md'), '# fixture 文档\n\n[返回上一级](../README.md)\n')
  put(join('repo', 'docs', 'README.md'), '# docs README\n\n历史来源目录 fixture。\n')
  const gitEnv = ['-c', 'user.name=yan-test', '-c', 'user.email=yan@test']
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', [...gitEnv, 'add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', [...gitEnv, 'commit', '-q', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' })
  } catch (error) {
    throw new Error(
      'fixture 仓库初始化失败（L03 的 worktree 场景需要 git）：' + (error instanceof Error ? error.message : String(error))
    )
  }

  const reviewRepo = join(dir, 'review')
  mk('review')
  const rgit = (args) => execFileSync('git', args, { cwd: reviewRepo, stdio: 'ignore' })
  const rgitC = (...args) => execFileSync('git', [...gitEnv, ...args], { cwd: reviewRepo, stdio: 'ignore' })
  rgit(['init', '-q', '-b', 'main'])
  rgit(['config', 'core.autocrlf', 'false'])
  put(join('review', 'modify.txt'), 'one\ntwo\nthree\n')
  put(join('review', 'a-deleted.txt'), 'bye\n')
  put(join('review', 'renamed.txt'), 'rename me\n')
  {
    const lines = []
    for (let i = 1; i <= 80; i += 1) lines.push(`line ${i}`)
    put(join('review', 'multi.txt'), lines.join('\n') + '\n')
  }
  mk('review', 'src')
  put(join('review', 'src', 'app.ts'), ['export function app() {', '  return 1', '}', ''].join('\n'))
  mk('review', 'docs', '中文 目录')
  put(join('review', 'docs', '中文 目录', '说明.md'), '# 说明\n\n第一行\n第二行\n')
  writeFileSync(join(reviewRepo, 'pic.png'), makePng(24, [32, 96, 200]))
  rgitC('add', '-A')
  rgitC('commit', '-q', '-m', 'review fixture base')

  put(join('review', 'modify.txt'), 'one\nTWO\nthree\nfour\n')
  {
    const lines = []
    for (let i = 1; i <= 80; i += 1) {
      if (i === 2) lines.push('line 2 CHANGED')
      else if (i === 79) lines.push('line 79 CHANGED')
      else lines.push(`line ${i}`)
    }
    put(join('review', 'multi.txt'), lines.join('\n') + '\n')
  }
  rmSync(join(reviewRepo, 'a-deleted.txt'), { force: true })
  rgitC('mv', 'renamed.txt', 'renamed-new.txt')
  put(join('review', 'staged-new.txt'), 'brand new\n')
  rgitC('add', 'staged-new.txt')
  put(join('review', 'docs', '中文 目录', '说明.md'), '# 说明\n\n第一行\n改过的第二行\n')
  put(join('review', 'untracked.txt'), 'u1\nu2\nu3\n')
  writeFileSync(join(reviewRepo, 'pic.png'), makePng(24, [220, 48, 48]))
  writeFileSync(join(reviewRepo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]))
  put(join('review', 'src', 'app.ts'), ['export function app() {', '  return 2', '}', ''].join('\n'))

  mk('probe-ext')
  mk('probe-ext', 'extensions')
  put(join('probe-ext', 'package.json'), JSON.stringify({
    name: 'yan-probe-ext',
    version: '9.9.9',
    description: '探针用的假扩展（P2 的真实安装路径）',
    license: 'MIT',
    keywords: ['pi-package']
  }, null, 2))
  put(join('probe-ext', 'extensions', 'index.js'), 'export default {}\n')

  mk('pkgs')
  mk('pkgs', 'probe-ext')
  mk('pkgs', 'probe-ext', 'extensions')
  put(join('pkgs', 'probe-ext', 'package.json'), JSON.stringify({
    name: 'yan-probe-ext',
    version: '9.9.9',
    description: '探针用的假扩展（P2 的真实安装路径）',
    license: 'MIT',
    keywords: ['pi-package']
  }, null, 2))
  put(join('pkgs', 'probe-ext', 'extensions', 'index.js'), 'export default {}\n')

  const writeRepo = join(dir, 'write')
  mk('write')
  const wgit = (args) => execFileSync('git', args, { cwd: writeRepo, stdio: 'ignore' })
  const wgitC = (...args) => execFileSync('git', [...gitEnv, ...args], { cwd: writeRepo, stdio: 'ignore' })
  wgit(['init', '-q', '-b', 'main'])
  wgit(['config', 'core.autocrlf', 'false'])
  wgit(['config', 'user.name', 'yan-test'])
  wgit(['config', 'user.email', 'yan-test@example.com'])
  put(join('write', 'a.txt'), 'a1\na2\na3\n')
  put(join('write', 'b.txt'), 'b1\n')
  put(join('write', 'dirty.txt'), 'clean\n')
  mk('write', 'src')
  put(join('write', 'src', 'app.ts'), 'export const v = 1\n')
  wgitC('add', '-A')
  wgitC('commit', '-q', '-m', 'write fixture base')
  wgitC('switch', '-q', '-c', 'feature')
  put(join('write', 'b.txt'), 'b1 on feature\n')
  wgitC('commit', '-qam', 'feature changes b.txt')
  wgitC('switch', '-q', 'main')
  const writeRemote = join(dir, 'write-remote.git')
  execFileSync('git', ['init', '-q', '--bare', writeRemote], { stdio: 'ignore' })
  wgit(['remote', 'add', 'origin', writeRemote])
  wgitC('push', '-q', '-u', 'origin', 'main')
  put(join('write', 'a.txt'), 'a1\nA2-CHANGED\na3\n')
  put(join('write', 'new.txt'), 'fresh\n')
  put(join('write', 'dirty.txt'), 'dirty\n')
  put(join('write', 'notes.txt'), 'note\n')


  try {
    symlinkSync(join(dir, 'deep'), join(dir, 'junction-dir'), 'junction')
  } catch {
  }
  try {
    symlinkSync(join(dir, 'README.md'), join(dir, 'junction-file'))
  } catch {
  }
  if (!noPermDenied) {
    console.log('  ⤺ 无权限目录没造成（icacls deny 失败），fsedge 会跳过那组断言')
  }

  mk('tasks')
  put(
    join('tasks', 'task-set.json'),
    JSON.stringify(
      {
        action: 'set',
        items: [{ text: '确认范围' }, { text: '实现宿主任务服务' }, { text: '真实运行验收' }]
      },
      null,
      2
    ) + '\n'
  )
  put(
    join('tasks', 'task-complete.json'),
    JSON.stringify({ action: 'complete', index: 2 }, null, 2) + '\n'
  )

  return dir
}

function seedSessions(destRoot) {
  const project = '--C--Users-Test--'
  const destDir = join(destRoot, project)
  mkdirSync(destDir, { recursive: true })
  let n = 0

  try {
    const real = join(homedir(), '.pi', 'agent', 'sessions')
    if (!SYNTHETIC_ONLY && existsSync(real)) {
      const found = []
      const walk = (dir, depth) => {
        if (depth > 2) return
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) walk(p, depth + 1)
          else if (e.name.endsWith('.jsonl')) {
            found.push({ path: p, project: basename(dir), mtime: statSync(p).mtimeMs })
          }
        }
      }
      walk(real, 0)

      for (const f of found.sort((a, b) => b.mtime - a.mtime).slice(0, 3)) {
        const d = join(destRoot, f.project)
        mkdirSync(d, { recursive: true })
        copyFileSync(f.path, join(d, basename(f.path)))
        n++
      }
    }
  } catch (e) {
    console.log('  ⚠️  拷贝真实会话失败：' + e.message)
  }

  for (const extra of (SYNTHETIC_ONLY ? [] : (process.env.YAN_TEST_EXTRA_SESSIONS ?? '').split(';').filter(Boolean))) {
    try {
      copyFileSync(extra, join(destDir, basename(extra)))
      n++
    } catch (e) {
      console.log('  ⚠️  额外会话拷贝失败：' + e.message)
    }
  }

  writeTodoSession(destDir, 'yan-todo-fixture')
  n++

  writeBranchFamily(destDir, 'yan-family')
  n += 3

  writePlainSession(destDir, 'yan-plain-fixture', 20)
  n++

  writePlainSession(destDir, 'yan-bulk-fixture', 400)
  n++

  return n
}

function writeV3UsageFixture(sandboxRoot) {
  const usageSessions = join(sandboxRoot, 'usage-sessions')
  const mainDir = join(usageSessions, '--C--Fixture--')
  mkdirSync(mainDir, { recursive: true })
  const mainDay = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
  const childDay = new Date().toISOString()
  const messageLine = (id, role, timestamp, totalTokens) =>
    JSON.stringify({
      type: 'message',
      id,
      timestamp,
      message: { role, content: `合成 fixture（${role}）` },
      ...(totalTokens ? { provider: 'fixture', model: 'usage-main', usage: { totalTokens } } : {})
    })
  writeFileSync(
    join(mainDir, 'usage-main.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'usage-main', timestamp: mainDay, cwd: '/fixture' }),
      messageLine('usage-main-u1', 'user', mainDay),
      messageLine('usage-main-a1', 'assistant', mainDay, 1000),
      messageLine('usage-main-u2', 'user', mainDay),
      messageLine('usage-main-a2', 'assistant', mainDay, 2000)
    ].join('\n') + '\n',
    'utf8'
  )
  const childDir = join(sandboxRoot, 'data', 'subagents', 'sessions', 'usage-child')
  mkdirSync(childDir, { recursive: true })
  writeFileSync(
    join(childDir, 'child.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'usage-child', timestamp: childDay, cwd: '/fixture' }),
      messageLine('usage-child-u1', 'user', childDay),
      messageLine('usage-child-a1', 'assistant', childDay, 5000),
      messageLine('usage-child-u2', 'user', childDay)
    ].join('\n') + '\n',
    'utf8'
  )
  return { usageSessions, mainTokens: 3000, subTokens: 5000, mainMessages: 4 }
}

function writeRemoteRouteSession(root, cwd) {
  const id = 'yan-remote-route-target'
  const timestamp = new Date().toISOString()
  const file = join(root, `2026-09-20T00-00-00-000Z_${id}.jsonl`)
  const lines = [
    { type: 'session', version: 3, id, timestamp, cwd },
    { type: 'model_change', id: 'mc0', parentId: null, timestamp, provider: 'yanrouteprobe', modelId: 'route-probe' },
    {
      type: 'message',
      id: 'u0',
      parentId: 'mc0',
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'Isolated remote route fixture' }] }
    },
    {
      type: 'message',
      id: 'a0',
      parentId: 'u0',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Ready for a local route check.' }],
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop'
      }
    }
  ]
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return { id, file }
}

function writeTodoSession(dir, idBase) {
  const id = `${idBase}-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`)
  const cwd = homedir()
  const m = (role, text, i, extra = {}) => ({
    type: 'message',
    id: 'm' + i,
    parentId: i === 0 ? null : 'm' + (i - 1),
    timestamp: TS(100 - i),
    message: {
      role,
      content: [{ type: 'text', text }],
      ...(role === 'assistant'
        ? {
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop'
          }
        : {}),
      ...extra
    }
  })

  const lines = [
    { type: 'session', version: 3, id, timestamp: TS(200), cwd },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp: TS(200),
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    },
    m('user', 'YAN-TODO fixture：用来验证任务清单渲染', 0),
    m('assistant', '好，我把计划列出来。', 1),
    {
      type: 'custom',
      id: 'task0',
      parentId: 'm1',
      timestamp: TS(90),
      customType: 'left-panel-tasks',
      data: {
        todos: [
          { text: '读 spec 并确认范围', done: true },
          { text: '写 protocol.ts 的 JSONL 分帧', done: true },
          { text: '把渲染端的假数据换成 MainPush 补丁', done: false },
          { text: '补测试并用真实应用跑一遍回归', done: false }
        ]
      }
    }
  ]

  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
}

function writeBranchFamily(dir, idBase) {
  const stamp = Date.now().toString(36)
  const cwd = homedir()
  const T0 = Date.now() - 60_000
  const iso = (ms) => new Date(ms).toISOString()
  const msg = (id, parentId, role, text, ts) => ({
    type: 'message',
    id,
    parentId,
    timestamp: iso(ts),
    message: {
      role,
      content: [{ type: 'text', text }],
      ...(role === 'assistant'
        ? {
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop'
          }
        : {})
    }
  })
  const modelLine = {
    type: 'model_change',
    id: 'mc0',
    parentId: null,
    timestamp: iso(T0),
    provider: 'commandcode',
    modelId: 'deepseek/deepseek-v4.1-flash'
  }
  const ORIGIN = 'YAN-FAMILY 源问题：这段对话要怎么分帧？'

  const parentFile = join(dir, `2026-01-05T00-00-00-000Z_${idBase}-parent-${stamp}.jsonl`)
  writeFileSync(
    parentFile,
    [
      { type: 'session', version: 3, id: `${idBase}-parent-${stamp}`, timestamp: iso(T0), cwd },
      modelLine,
      msg('fu0', 'mc0', 'user', ORIGIN, T0 + 1),
      msg('fa0', 'fu0', 'assistant', '按行切就行。', T0 + 2)
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
    'utf8'
  )

  for (let i = 1; i <= 2; i++) {
    const forkTs = T0 + i * 1000
    const file = join(dir, `2026-01-05T00-00-0${i}-000Z_${idBase}-child${i}-${stamp}.jsonl`)
    writeFileSync(
      file,
      [
        {
          type: 'session',
          version: 3,
          id: `${idBase}-child${i}-${stamp}`,
          timestamp: iso(forkTs),
          cwd,
          parentSession: parentFile
        },
        modelLine,
        msg('fu0', 'mc0', 'user', ORIGIN, T0 + 1),
        msg('fa0', 'fu0', 'assistant', '按行切就行。', T0 + 2),
        msg(`c${i}u`, 'fa0', 'user', `YAN-FAMILY 分支${i}：改用方案 ${i}`, forkTs + 1),
        msg(`c${i}a`, `c${i}u`, 'assistant', `好，用方案 ${i}。`, forkTs + 2)
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
      'utf8'
    )
  }
}

function writePlainSession(dir, idBase, count) {
  const id = `${idBase}-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-02T00-00-00-000Z_${id}.jsonl`)
  const cwd = homedir()
  const lines = [
    { type: 'session', version: 3, id, timestamp: TS(500), cwd },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp: TS(500),
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    }
  ]
  for (let i = 0; i < count; i++) {
    lines.push({
      type: 'message',
      id: 'p' + i,
      parentId: i === 0 ? 'mc0' : 'p' + (i - 1),
      timestamp: TS(400 - i),
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `YAN-PLAIN fixture 第 ${i} 条消息` }],
        ...(i % 2 === 1
          ? {
              usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'stop'
            }
          : {})
      }
    })
  }
  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
}

function writeContextGuardSession(dir) {
  const id = `yan-context-guard-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-06T00-00-00-000Z_${id}.jsonl`)
  const text = 'context guard fixture '.repeat(320)
  const timestamp = new Date(Date.now() - 120_000).toISOString()
  const lines = [
    { type: 'session', version: 3, id, timestamp, cwd: homedir() },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp,
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    },
    {
      type: 'message',
      id: 'u0',
      parentId: 'mc0',
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'YAN-CONTEXT-GUARD fixture' }] }
    },
    {
      type: 'message',
      id: 'a0',
      parentId: 'u0',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: {
          input: 1024,
          output: 1024,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop'
      }
    }
  ]
  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  return file
}

function writeAbSessions(root, cwdA, cwdB) {
  const stamp = Date.now().toString(36)
  const made = []
  const one = (tag, cwd) => {
    const id = `yan-ab-${tag}-${stamp}`
    const file = join(root, `2026-01-03T00-00-00-000Z_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: TS(600), cwd },
      {
        type: 'model_change',
        id: 'mc0',
        parentId: null,
        timestamp: TS(600),
        provider: 'commandcode',
        modelId: 'deepseek/deepseek-v4.1-flash'
      },
      {
        type: 'message',
        id: 'a0',
        parentId: 'mc0',
        timestamp: TS(590),
        message: { role: 'user', content: [{ type: 'text', text: `YAN-AB-${tag.toUpperCase()} fixture 会话` }] }
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'a0',
        timestamp: TS(580),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `YAN-AB-${tag.toUpperCase()}-REPLY` }],
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop'
        }
      }
    ]
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    made.push({ tag, id, file, cwd })
  }
  one('a', cwdA)
  one('b', cwdB)
  one('c', cwdA)
  return made
}

function writeProjectSwitchSessions(root, cwdA, cwdB, opts = {}) {
  const stamp = Date.now().toString(36)
  const made = []
  const one = (tag, cwd, skew = 0) => {
    const id = `yan-n05-${tag}-${stamp}`
    const file = join(root, `2026-01-04T00-00-00-000Z_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: TS(700 - skew), cwd },
      {
        type: 'model_change',
        id: 'mc0',
        parentId: null,
        timestamp: TS(700 - skew),
        provider: 'commandcode',
        modelId: 'deepseek/deepseek-v4.1-flash'
      },
      {
        type: 'message',
        id: 'u0',
        parentId: 'mc0',
        timestamp: TS(690 - skew),
        message: { role: 'user', content: [{ type: 'text', text: `YAN-N05-${tag.toUpperCase()} fixture 会话` }] }
      },
      {
        type: 'message',
        id: 'a0',
        parentId: 'u0',
        timestamp: TS(680 - skew),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `YAN-N05-${tag.toUpperCase()}-REPLY` }],
          usage: {
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop'
        }
      }
    ]
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    const t = (Date.now() - (900 + skew) * 1000) / 1000
    try {
      utimesSync(file, t, t)
    } catch {
    }
    made.push({ tag, cwd, file })
  }
  one('a', cwdA)
  one('b', cwdB)
  if (opts.peers && opts.peerCwd) {
    one('d', opts.peerCwd, 0)
    one('e', opts.peerCwd, 100)
  }
  if (opts.opened) {
    one('hot', cwdA, 300)
    one('opened', cwdA, 50)
  }
  return made
}

function checkProbeSyntax(probe) {
  try {
    const src = readFileSync(join(root, probe), 'utf8')
    new vm.Script(src, { filename: probe })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const KNOWLEDGE_FIXTURE_PROJECT_ID = 'proj-fixture'
const KNOWLEDGE_FIXTURE_ENTRY_ID = 'kn-deploy'
const KNOWLEDGE_FIXTURE_TEXT = '发布流程统一走 npm run dist，先跑完整门槛'
const KNOWLEDGE_FIXTURE_CANDIDATE_ID = 'k-candidate01'
const KNOWLEDGE_FIXTURE_CANDIDATE_TEXT = 'out/ 是构建产物目录，跑单测前先 build'

async function seedGoalDocument(dataDir, sessionsDir) {
  const now = Date.now()
  const goalFor = (sessionKey) => ({
    goalId: 'g-probe-links',
    phase: 'executing',
    revision: 3,
    steps: [
      { title: '接上结构化链接', status: 'done' },
      { title: '验产物/参考展示', status: 'pending' }
    ],
    evidence: ['npm run test:unit 4712/4712'],
    budget: { tokens: 200000, ms: 600000 },
    budgetUsage: { tokens: 312000, at: now },
    budgetStop: { at: now, reason: 'tokens', detail: '已用 312000 tokens，达到预算 200000' },
    links: [
      {
        kind: 'file',
        target: 'probe-missing-file.txt',
        label: '不存在的文件（验失败反馈）',
        source: { sessionId: sessionKey, messageId: 'm-probe' },
        check: { at: now, ok: false, method: 'exists', detail: '文件不存在（可能已被移动或删除）' },
        addedAt: now
      },
      {
        kind: 'url',
        target: 'https://example.com/spec',
        label: '规格（不会被点击）',
        check: { at: now, ok: true, method: 'exists', detail: 'url 仅做形态校验（宿主不联网）' },
        addedAt: now
      },
      {
        kind: 'artifact',
        target: 'out/probe.png',
        label: '产物',
        check: { at: now, ok: false, method: 'exists', detail: '文件不存在（可能已被移动或删除）' },
        addedAt: now
      }
    ],
    blocker: null,
    pursue: false,
    brief: null,
    verification: {
      status: 'failed',
      at: now,
      checks: [
        {
          target: 'probe-missing-file.txt',
          kind: 'file',
          ok: false,
          detail: '文件不存在（可能已被移动或删除）',
          at: now
        },
        {
          target: 'https://example.com/spec',
          kind: 'url',
          ok: true,
          detail: 'url 仅做形态校验（宿主不联网）',
          at: now
        },
        {
          target: 'out/probe.png',
          kind: 'artifact',
          ok: false,
          detail: '文件不存在（可能已被移动或删除）',
          at: now
        }
      ],
      detail: '2 项本地产物不存在（可能已被移动或删除）'
    },
    failure: null,
    updatedAt: now
  })
  const entries = {}
  let files = []
  try {
    files = readdirSync(sessionsDir, { recursive: true })
      .map((name) => String(name))
      .filter((name) => name.endsWith('.jsonl'))
  } catch {
    files = []
  }
  for (const rel of files) {
    const key = join(sessionsDir, rel)
    entries[key] = {
      goal: goalFor(key),
      transitions: {},
      reports: {},
      resume: null,
      autoContinues: 0,
      paused: false,
      repeatCursor: null,
      updatedAt: now
    }
  }
  writeFileSync(join(dataDir, 'goals.json'), JSON.stringify({ version: 1, entries }, null, 2), 'utf8')
  return files.length
}

async function seedPendingGoalReview(dataDir, sessionsDir) {
  const now = Date.now()
  const files = readdirSync(sessionsDir, { recursive: true })
    .map((name) => String(name))
    .filter((name) => name.endsWith('.jsonl'))
  const goalId = 'goal-review-modify-fixture'
  const transitionId = 'tr-review-modify-fixture'
  const understanding = {
    goal: '隔离测试待审计划',
    deliverable: '修改后重新确认',
    scope: '仅测试会话',
    constraints: '修改时不开始执行',
    acceptance: '待审快照已撤销'
  }
  const goals = {}
  for (const rel of files) {
    const key = join(sessionsDir, rel)
    goals[key] = {
      goal: {
        goalId,
        phase: 'planning',
        revision: 3,
        steps: [],
        evidence: [],
        links: [],
        verification: null,
        budget: null,
        budgetStop: null,
        budgetUsage: null,
        blocker: null,
        pursue: false,
        brief: null,
        readyApproval: 'review',
        pendingReady: {
          transitionId,
          goalId,
          modeRevision: 1,
          goalRevision: 3,
          understanding,
          createdAt: now
        },
        failure: null,
        updatedAt: now
      },
      transitions: {},
      reports: {},
      resume: null,
      autoContinues: 0,
      paused: false,
      repeatCursor: null,
      updatedAt: now
    }
  }
  writeFileSync(join(dataDir, 'goals.json'), JSON.stringify({ version: 1, entries: goals }, null, 2), 'utf8')
  return files.length
}

async function seedProjectKnowledge(dataDir, opts = {}) {
  const projectId = KNOWLEDGE_FIXTURE_PROJECT_ID
  const { pathToFileURL } = await import('node:url')
  const memory = await import(pathToFileURL(join(root, 'src/shared/project-memory.ts')).href)
  const now = new Date().toISOString()
  const entry = {
    schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    id: KNOWLEDGE_FIXTURE_ENTRY_ID,
    projectId,
    revision: 1,
    kind: 'decision',
    status: 'active',
    text: KNOWLEDGE_FIXTURE_TEXT,
    textDigest: memory.textDigest(KNOWLEDGE_FIXTURE_TEXT),
    tags: ['发布'],
    evidence: [{ sessionId: 'fixture' }],
    confidenceClass: 'user-confirmed',
    createdAt: now,
    updatedAt: now
  }
  const candidate = opts.withCandidate
    ? {
        ...entry,
        id: KNOWLEDGE_FIXTURE_CANDIDATE_ID,
        revision: 1,
        kind: 'fact',
        status: 'candidate',
        text: KNOWLEDGE_FIXTURE_CANDIDATE_TEXT,
        textDigest: memory.textDigest(KNOWLEDGE_FIXTURE_CANDIDATE_TEXT),
        tags: [],
        evidence: [{ sessionId: opts.sessionId ?? 'fixture' }],
        confidenceClass: 'inferred'
      }
    : null
  if (opts.sessionId) entry.evidence = [{ sessionId: opts.sessionId }]
  const entries = [entry, ...(candidate ? [candidate] : [])]
  const manifest = {
    schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    projectId,
    revision: 1,
    updatedAt: now,
    entries: entries.map((item) => memory.pointerOf(item))
  }
  const dir = join(dataDir, 'project-knowledge', projectId)
  for (const item of entries) {
    mkdirSync(join(dir, 'entries', item.id), { recursive: true })
    writeFileSync(join(dir, 'entries', item.id, 'r1.json'), JSON.stringify(item, null, 2), 'utf8')
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(
    `  项目知识 fixture：${projectId}/${entry.id}${candidate ? ` + ${candidate.id}（候选）` : ''}（digest ${entry.textDigest.slice(0, 8)}${opts.sessionId ? `，来源会话 ${opts.sessionId}` : ''}）`
  )
}

const KNOWLEDGE_ISO_A_ID = 'kn-iso-a'
const KNOWLEDGE_ISO_A_TEXT = 'fixture：主仓库的发布流程统一走 npm run dist'
const KNOWLEDGE_ISO_B_ID = 'kn-iso-b'
const KNOWLEDGE_ISO_B_TEXT = 'fixture：另一个项目的接口约定（与主仓库无关）'
const KNOWLEDGE_ISO_TITLES = { a: 'YAN-ISO-A', b: 'YAN-ISO-B', w: 'YAN-ISO-W' }
const KNOWLEDGE_ISO_STASH_KEY = 'yan.probe.knowledge-iso.v1'
const LEGACY_DATA_SENTINELS = [
  { name: 'memory.json', body: '{"entries":[{"id":"old-1","text":"用户遗留的旧记忆，不许被删除或改写"}]}\n' },
  { name: 'soul.md', body: '# soul\n\n用户遗留的旧人设文件，逐字节不许变。\n' }
]

function writeIsolationSessions(root, cwdA, cwdB, cwdW) {
  const stamp = Date.now().toString(36)
  const made = {}
  const one = (tag, key, cwd, skew) => {
    const id = `yan-iso-${tag}-${stamp}`
    const file = join(root, `2026-01-05T00-00-00-000Z_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: TS(800 - skew), cwd },
      { type: 'model_change', id: 'mc0', parentId: null, timestamp: TS(800 - skew), provider: 'commandcode', modelId: 'deepseek/deepseek-v4.1-flash' },
      {
        type: 'message',
        id: 'u0',
        parentId: 'mc0',
        timestamp: TS(790 - skew),
        message: { role: 'user', content: [{ type: 'text', text: `${KNOWLEDGE_ISO_TITLES[key]} fixture 会话` }] }
      },
      {
        type: 'message',
        id: 'a0',
        parentId: 'u0',
        timestamp: TS(780 - skew),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${KNOWLEDGE_ISO_TITLES[key]}-REPLY` }],
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop'
        }
      }
    ]
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    const t = (Date.now() - (900 + skew) * 1000) / 1000
    try {
      utimesSync(file, t, t)
    } catch {
    }
    made[key] = { tag, cwd, file }
  }
  one('a', 'a', cwdA, 0)
  one('b', 'b', cwdB, 10)
  one('w', 'w', cwdW, 20)
  return made
}

async function seedKnowledgeIsolation(sandboxRoot, fixtureProject, caseCwd) {
  const { pathToFileURL } = await import('node:url')
  const ids = await import(pathToFileURL(join(root, 'src/main/project-id.ts')).href)
  const memory = await import(pathToFileURL(join(root, 'src/shared/project-memory.ts')).href)

  const cwdA = caseCwd
  const cwdB = join(fixtureProject, 'other')
  const worktreeRoot = join(fixtureProject, 'repo-worktrees')
  const cwdW = join(worktreeRoot, 'iso')

  let worktreeIsReal = false
  try {
    mkdirSync(worktreeRoot, { recursive: true })
    execFileSync('git', ['-c', 'user.name=yan-test', '-c', 'user.email=yan@test', 'worktree', 'add', '-q', '-b', `iso-${Date.now().toString(36)}`, cwdW], {
      cwd: cwdA,
      stdio: 'ignore'
    })
    worktreeIsReal = true
  } catch (error) {
    mkdirSync(cwdW, { recursive: true })
    console.log(`  ⚠️  工作树没建起来（${error instanceof Error ? error.message : String(error)}）—— 退化成普通目录，路径前缀不变`)
  }

  const idA = ids.legacyProjectId(cwdA)
  const idB = ids.hashedProjectId(cwdB)
  const legacyW = ids.legacyProjectId(cwdW)

  const entry = (key, id, text, kind) => {
    const now = new Date().toISOString()
    return {
      schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
      id,
      projectId: key,
      revision: 1,
      kind,
      status: 'active',
      text,
      textDigest: memory.textDigest(text),
      tags: [],
      evidence: [{ sessionId: 'fixture' }],
      confidenceClass: 'user-confirmed',
      createdAt: now,
      updatedAt: now
    }
  }
  const writeOne = (projectId, item) => {
    const dir = join(sandboxRoot, 'data', 'project-knowledge', projectId)
    mkdirSync(join(dir, 'entries', item.id), { recursive: true })
    writeFileSync(join(dir, 'entries', item.id, 'r1.json'), JSON.stringify(item, null, 2), 'utf8')
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
          projectId,
          revision: 1,
          updatedAt: item.updatedAt,
          entries: [memory.pointerOf(item)]
        },
        null,
        2
      ),
      'utf8'
    )
  }
  writeOne(idA, entry(idA, KNOWLEDGE_ISO_A_ID, KNOWLEDGE_ISO_A_TEXT, 'decision'))
  writeOne(idB, entry(idB, KNOWLEDGE_ISO_B_ID, KNOWLEDGE_ISO_B_TEXT, 'fact'))

  writeFileSync(
    join(sandboxRoot, 'data', 'desktop.json'),
    JSON.stringify(
      {
        cwd: cwdA,
        lang: 'zh-CN',
        projectKnowledge: { enabled: true },
        projects: [
          { id: idA, cwd: cwdA, name: '主仓库', archived: false, createdAt: Date.now(), updatedAt: Date.now() },
          { id: idB, cwd: cwdB, name: '另一个项目', archived: false, createdAt: Date.now(), updatedAt: Date.now() }
        ]
      },
      null,
      2
    ),
    'utf8'
  )

  const sessions = join(sandboxRoot, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const made = writeIsolationSessions(sessions, cwdA, cwdB, cwdW)

  const sentinels = []
  for (const base of [join(sandboxRoot, 'pi-agent'), join(sandboxRoot, 'data')]) {
    mkdirSync(base, { recursive: true })
    for (const sentinel of LEGACY_DATA_SENTINELS) {
      const path = join(base, sentinel.name)
      writeFileSync(path, sentinel.body, 'utf8')
      sentinels.push({ path, body: sentinel.body })
    }
  }

  console.log(`  隔离 fixture：A=${idA.slice(0, 18)}…(登记) / B=${idB.slice(0, 18)}…(登记·哈希) / W=${legacyW.slice(0, 18)}…(工作树·未登记)`)
  console.log(`    工作树：${cwdW}${worktreeIsReal ? '（真 git 工作树）' : '（普通目录）'}`)
  return { cwdA, cwdB, cwdW, idA, idB, legacyW, sessions: made, sentinels }
}

async function checkKnowledgeCli(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const manifestFile = join(sandboxRoot, 'data', 'project-knowledge', KNOWLEDGE_FIXTURE_PROJECT_ID, 'manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const entries = Array.isArray(manifest.entries) ? manifest.entries : []
    const active = entries.filter((entry) => entry.status === 'active')
    const candidates = entries.filter((entry) => entry.status === 'candidate')
    lines.push(`  manifest：revision=${manifest.revision} 共 ${entries.length} 条（active ${active.length} / candidate ${candidates.length}）`)
    for (const entry of entries) lines.push(`    ${entry.id} ${entry.status} ${entry.kind}`)
    say(entries.length >= 2, '磁盘上真的多了一条（propose 写进去了）')
    say(candidates.length >= 1, '新条目落成 candidate（模型不能自证 user-confirmed）')
    say(active.length === 1, 'active 条目仍然只有 fixture 那一条')
  } catch (error) {
    say(false, '读 manifest 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(!/\[knowledgecli\]\s+[1-9]\d*\s+条失败/.test(probeText), '探针自身没有失败项')
  return { ok, lines }
}

async function checkKnowledgeTab(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const manifestFile = join(sandboxRoot, 'data', 'project-knowledge', KNOWLEDGE_FIXTURE_PROJECT_ID, 'manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const entries = Array.isArray(manifest.entries) ? manifest.entries : []
    lines.push(`  manifest：revision=${manifest.revision} 共 ${entries.length} 条`)
    for (const entry of entries) lines.push(`    ${entry.id} ${entry.status} rev ${entry.revision}`)
    const deleted = entries.find((entry) => entry.id === KNOWLEDGE_FIXTURE_CANDIDATE_ID)
    const untouched = entries.find((entry) => entry.id === KNOWLEDGE_FIXTURE_ENTRY_ID)
    say(!!deleted, '被删的那条仍在 manifest 里（逻辑删除，不是抹掉）')
    say(deleted?.status === 'deleted', '被删的那条状态是 deleted')
    say((deleted?.revision ?? 0) >= 4, `revision 至少加了 3（确认 / 编辑 / 删除）：${deleted?.revision}`)
    say(untouched?.status === 'active' && untouched?.revision === 1, '另一条 fixture 完全没被动过（active / rev 1）')
    const tombstoneFile = join(
      sandboxRoot,
      'data',
      'project-knowledge',
      KNOWLEDGE_FIXTURE_PROJECT_ID,
      'entries',
      KNOWLEDGE_FIXTURE_CANDIDATE_ID,
      `r${deleted?.revision ?? 0}.json`
    )
    const tombstone = JSON.parse(readFileSync(tombstoneFile, 'utf8'))
    say(typeof tombstone.text === 'string' && tombstone.text.length > 0, '墓碑保留正文（逻辑删除可恢复）')
    say(tombstone.status === 'deleted', '那版 revision 文件本身也是 deleted 状态')
  } catch (error) {
    say(false, '读 manifest / 墓碑失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(!/\[knowledgetab\]\s+[1-9]\d*\s+条失败/.test(probeText), '探针自身没有失败项')
  return { ok, lines }
}

async function checkKnowledgeIsolation(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const { pathToFileURL } = await import('node:url')
  const ids = await import(pathToFileURL(join(root, 'src/main/project-id.ts')).href)
  const memory = await import(pathToFileURL(join(root, 'src/shared/project-memory.ts')).href)
  const fixtureProject = join(sandboxRoot, 'fixture-project')
  const cwdA = join(fixtureProject, 'repo')
  const cwdB = join(fixtureProject, 'other')
  const cwdW = join(fixtureProject, 'repo-worktrees', 'iso')
  const idA = ids.legacyProjectId(cwdA)
  const idB = ids.hashedProjectId(cwdB)
  const idW = ids.hashedProjectId(cwdW)
  const knDir = (projectId) => join(sandboxRoot, 'data', 'project-knowledge', projectId)
  const readManifest = (projectId) => JSON.parse(readFileSync(join(knDir(projectId), 'manifest.json'), 'utf8'))

  say(
    ids.legacyProjectId(cwdW) === idA,
    '前提成立：工作树的旧算法 id 与主仓库完全相同（路径前 27 字节被截断）',
  )
  say(idB !== idA, '另一个项目的登记 id 与主仓库不同（碰撞退路生效）')

  try {
    const manifestA = readManifest(idA)
    const manifestB = readManifest(idB)
    const entryA = (manifestA.entries ?? []).find((entry) => entry.id === KNOWLEDGE_ISO_A_ID)
    const entryB = (manifestB.entries ?? []).find((entry) => entry.id === KNOWLEDGE_ISO_B_ID)
    lines.push(`  A(${idA.slice(0, 18)}…) → ${(manifestA.entries ?? []).map((e) => e.id).join(', ') || '（空）'}`)
    lines.push(`  B(${idB.slice(0, 18)}…) → ${(manifestB.entries ?? []).map((e) => e.id).join(', ') || '（空）'}`)
    say(entryA?.status === 'active', 'A 的条目在 A 的知识目录里（active）')
    say(entryB?.status === 'active', 'B 的条目在 B 的知识目录里（active）')
    say(
      entryA?.digest === memory.textDigest(KNOWLEDGE_ISO_A_TEXT),
      'A 的条目正文指纹与 fixture 一致（逐字节没被改动）',
    )
    say(
      !(manifestA.entries ?? []).some((entry) => entry.id === KNOWLEDGE_ISO_B_ID),
      'A 的目录里**没有** B 的条目（物理隔离，不靠查询条件）',
    )
    say(
      !(manifestB.entries ?? []).some((entry) => entry.id === KNOWLEDGE_ISO_A_ID),
      'B 的目录里**没有** A 的条目',
    )
  } catch (error) {
    say(false, '读项目 manifest 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const worktreeManifest = existsSync(join(knDir(idW), 'manifest.json')) ? readManifest(idW) : null
    lines.push(
      `  工作树 id（哈希）→ ${worktreeManifest ? (worktreeManifest.entries ?? []).map((e) => e.id).join(', ') : '（没有知识目录）'}`,
    )
    say(
      !worktreeManifest || (worktreeManifest.entries ?? []).length === 0,
      '工作树没有拿到任何条目（即使没有知识目录也算通过 —— 它不该读主仓库的）',
    )
  } catch (error) {
    say(false, '读工作树知识目录失败：' + (error instanceof Error ? error.message : String(error)))
  }

  const idLine = /\[knowledgeisolation\] ids=(\{[^\n]*\})/.exec(probeText)
  let runtimeIds = null
  if (!idLine) {
    say(false, '探针没有打印运行时的 projectId（拿不到隔离的直接证据）')
  } else {
    try {
      runtimeIds = JSON.parse(idLine[1])
      lines.push(`  运行时 id = ${JSON.stringify(runtimeIds)}`)
      say(runtimeIds.a === idA, '主仓库会话用的就是登记 id')
      say(runtimeIds.b === idB, '另一个项目会话用的是哈希 id（登记过）')
      say(runtimeIds.w === idW, '工作树会话用的是哈希 id —— 不是主仓库的 id（隔离成立）')
      say(runtimeIds.w !== runtimeIds.a, '工作树的 id 与主仓库不同（这就是旧算法会撞的地方）')
    } catch (error) {
      say(false, '解析探针 id 失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const restartLine = /\[knowledgeisolation\] restart=(\{[^\n]*\})/.exec(probeText)
  if (!restartLine) {
    say(false, '没有拿到重启探针的输出（cross-process 持久化没验到）')
  } else {
    try {
      const restart = JSON.parse(restartLine[1])
      lines.push(`  重启后 = ${JSON.stringify(restart)}`)
      say(restart.aHasEntry === true, '重启后主仓库仍能读到自己的条目（知识在盘上，不是内存态）')
      say(restart.aSameId === true, '重启后主仓库的 projectId 与上一次相同（派生确定性）')
      say(restart.bHasEntry === true, '重启后另一个项目仍能读到自己的条目')
      say(restart.wEmpty === true, '重启后工作树仍然读不到任何条目')
      say(restart.wSameId === true, '重启后工作树的 projectId 与上一次相同（哈希退路确定）')
    } catch (error) {
      say(false, '解析重启探针输出失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  say(!existsSync(join(root, 'project-knowledge')), '开发仓库根目录下没有被创建 project-knowledge（数据只在 YAN_DIR）')
  say(
    existsSync(knDir(idA)) && knDir(idA).startsWith(join(sandboxRoot, 'data')),
    '知识目录落在隔离的 YAN_DIR 下',
  )

  for (const base of ['pi-agent', 'data']) {
    for (const sentinel of LEGACY_DATA_SENTINELS) {
      const path = join(sandboxRoot, base, sentinel.name)
      let same = false
      try {
        same = readFileSync(path, 'utf8') === sentinel.body
      } catch {
        same = false
      }
      say(same, `旧用户数据逐字节不变：${base}/${sentinel.name}`)
    }
  }

  say(!/\[knowledgeisolation\]\s+[1-9]\d*\s+条失败/.test(probeText), '探针自身没有失败项')
  return { ok, lines }
}

function checkSubagentArchive(sandboxRoot, tempBefore) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'subagents')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const records = []
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
    }
  }
  lines.push(`  元数据 ${records.length} 份：${files.join(' ') || '（空）'}`)

  const byMark = (mark) => records.find((r) => String(r.task ?? '').includes(mark))
  const patchExists = (r) => !!r?.patchPath && existsSync(r.patchPath)

  const expect = (mark, review, label) => {
    const run = byMark(mark)
    say(!!run, `找到 ${label} 记录`)
    if (!run) return null
    say(run.review === review, `${label} review=${run.review}（期望 ${review}）`)
    return run
  }

  const alpha = expect('YAN-ALPHA', 'merged', 'ALPHA')
  if (alpha) say(patchExists(alpha), 'ALPHA 的补丁留在归档目录（合并后仍可追溯）')
  const beta = expect('YAN-BETA', 'discarded', 'BETA')
  if (beta) say(patchExists(beta), 'BETA 的补丁留在归档目录（放弃但没丢）')
  expect('YAN-CONFLICT-D', 'merged', 'CONFLICT-D')
  const conflictC = expect('YAN-CONFLICT-C', 'archived', 'CONFLICT-C')
  if (conflictC) say(patchExists(conflictC) || !conflictC.diff?.files, 'CONFLICT-C 的冲突补丁也归档了')
  const longrun = expect('YAN-LONGRUN', 'archived', 'LONGRUN')
  if (longrun) say(patchExists(longrun) || !longrun.diff?.files, 'LONGRUN 的退出归档落盘')
  expect('YAN-READONLY', 'none', 'READONLY')

  const repo = join(sandboxRoot, 'fixture-project', 'repo')
  say(existsSync(join(repo, 'alpha.txt')), '主工作树留住了已合并的 alpha.txt')
  say(!existsSync(join(repo, 'beta.txt')), '被放弃的 beta.txt 没有进主工作树')
  say(!existsSync(join(repo, 'readonly-attempt.txt')), '只读子代理没能写进主工作树')
  let readme = ''
  try {
    readme = readFileSync(join(repo, 'README.md'), 'utf8')
  } catch {
  }
  say(readme.includes('LINE-D'), '主工作树 README 是 CONFLICT-D 的版本')
  say(!readme.includes('LINE-C'), '冲突的 CONFLICT-C 没有被半截写入')

  const leftovers = readdirSync(tmpdir()).filter(
    (n) => n.startsWith('yan-subagent-') && !(tempBefore ?? new Set()).has(n)
  )
  for (const dir of leftovers) {
    const id = /^yan-subagent-(sub-[0-9a-f]+)-/.exec(dir)?.[1]
    const owner = records.find((r) => r.id === id)
    lines.push(`    残留 ${dir} → ${owner ? String(owner.task ?? '').slice(0, 24) + `（${owner.review}）` : '未知任务'}`)
  }
  say(leftovers.length === 0, `退出后没有残留的隔离目录（新增 ${leftovers.length} 个）`)

  return { ok, lines }
}

function checkSessionabArchive(sandboxRoot) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const sessionsRoot = join(sandboxRoot, 'sessions')
  const files = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []
  const fileOf = (tag) => files.find((f) => f.includes(`yan-ab-${tag}-`) && f.endsWith('.jsonl'))
  const readMessages = (file) => {
    const text = readFileSync(join(sessionsRoot, file), 'utf8')
    const msgs = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o.type === 'message') msgs.push(o.message)
      } catch {
      }
    }
    return msgs
  }
  const textOf = (msgs, role) =>
    msgs
      .filter((m) => m?.role === role)
      .map((m) => (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''))
      .join('\n')

  const fileA = fileOf('a')
  const fileB = fileOf('b')
  const fileC = fileOf('c')
  lines.push(`  A=${fileA ?? '（缺失）'}  B=${fileB ?? '（缺失）'}  C=${fileC ?? '（缺失）'}`)
  say(!!fileA && !!fileB && !!fileC, '三个会话文件都还在')
  if (!fileA || !fileB || !fileC) return { ok, lines }

  const msgsA = readMessages(fileA)
  const msgsB = readMessages(fileB)
  const msgsC = readMessages(fileC)
  const aText = textOf(msgsA, 'assistant')
  const bText = textOf(msgsB, 'assistant')
  const cText = textOf(msgsC, 'assistant')

  lines.push(`  A 落盘：${msgsA.length} 条消息，助手正文 ${aText.length} 字`)
  say(/sleep \d+/.test(JSON.stringify(msgsA)), 'A 的会话记录里有那次工具调用（真执行了）')
  say(msgsA.filter((m) => m?.role === 'assistant').length >= 2, 'A 的会话文件里多了模型自己的回合（被中断也算落盘）')
  say(!bText.includes('YAN-AB') || bText.includes('YAN-AB-B-REPLY'), 'B 的回复属于 B（没被 A 的内容覆盖）')
  say(cText.includes('YAN-AB-C-REPLY'), 'C 的回复原样保留（同 cwd 被拒的那次没写坏它）')
  say(msgsC.filter((m) => m?.role === 'assistant').length === 1, 'C 只有一个助手回合（被拒后确实没动它）')

  let readme = ''
  try {
    readme = readFileSync(join(sandboxRoot, 'fixture-project', 'repo', 'README.md'), 'utf8')
  } catch {
  }
  say(readme.includes('LINE-BASE'), '与 A 同 cwd 的仓库工作树没被弄坏')

  return { ok, lines }
}

function checkAtRefSend(sandboxRoot) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const sessionsRoot = join(sandboxRoot, 'sessions')
  const files = existsSync(sessionsRoot)
    ? readdirSync(sessionsRoot)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, t: statSync(join(sessionsRoot, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : []
  say(files.length > 0, `找到了会话文件（共 ${files.length} 个）`)
  if (!files.length) return { ok, lines }

  const file = files[0].f
  const raw = readFileSync(join(sessionsRoot, file), 'utf8')
  lines.push(`  最新会话 = ${file}（${raw.length} 字节）`)

  say(raw.includes('@README.md'), '引用路径原样送达模型（RPC 不展开 @，模型自行读取）')
  const readIt = raw.includes('fixture project')
  lines.push(`  （模型本轮是否真去读了该文件：${readIt ? '是' : '否'}；会话 ${raw.length} 字节）`)
  say(/read|已读|第一行/.test(raw), '模型按任务回了话（引用语法没有打断这一轮）')

  return { ok, lines }
}

function checkGitWriteApplied(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const repo = join(sandboxRoot, 'fixture-project', 'write')
  const bare = join(sandboxRoot, 'fixture-project', 'write-remote.git')
  const read = (args, cwd = repo) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  try {
    lines.push(
      '  ⓘ 实际：HEAD=' +
        read(['log', '-1', '--pretty=%s']) +
        ' / 分支=' +
        read(['rev-parse', '--abbrev-ref', 'HEAD']) +
        ' / 最近三条=' +
        JSON.stringify(read(['log', '-3', '--pretty=%s']).split(String.fromCharCode(10)))
 +
        ' / 全部分支提交=' +
        JSON.stringify(read(['log', '--all', '--pretty=%h %s']).split(String.fromCharCode(10))) +
        ' / main=' +
        read(['rev-parse', 'main']) +
        ' live-made=' +
        read(['rev-parse', '--verify', 'live-made'])
    )
    say(
      read(['log', '-1', '--pretty=%s']) === 'feat: live 写操作验收',
      'HEAD 上的提交正是界面上输入的那条说明'
    )
    say(read(['rev-parse', '--abbrev-ref', 'HEAD']) === 'main', '收尾时停在 main 分支（探针最后切回来了）')
    say(read(['branch', '--list', 'live-made']) !== '', '新建的分支 live-made 真的存在')

    const status = read(['status', '--porcelain'])
    const aLine = status.split('\n').find((l) => l.endsWith('a.txt')) ?? ''
    say(
      aLine === '' || aLine.startsWith('??') === false,
      'a.txt 没有留在「已暂存」里（暂存的内容随提交进了历史）[' + aLine + ']'
    )

    const localHead = read(['rev-parse', 'HEAD'])
    const remoteHead = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    say(localHead === remoteHead, 'bare remote 里的 main 与本地 HEAD 相同（推送成功）')
  } catch (error) {
    say(false, '退出后读仓库失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(/\[gitwrite\]/.test(probeText), '探针确实跑到了写操作场景（输出里有 [gitwrite] 小结）')

  try {
    const trustFile = join(sandboxRoot, 'pi-agent', 'trust.json')
    const table = JSON.parse(readFileSync(trustFile, 'utf8'))
    const keys = Object.keys(table)
    const wtKey = keys.find((k) => /live-carry/i.test(k))
    say(keys.length >= 2, 'trust.json 里至少有两条（主仓库 + 工作树）：' + keys.length)
    say(!!wtKey, '其中一条是工作树目录：' + String(wtKey ?? '(无)'))
    say(keys.every((k) => table[k] === true), '两条的值都是 true（没有写出 false 条目）')
  } catch (error) {
    say(false, '退出后读 trust.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }
  if (/\[gitwrite\]\s+[1-9]\d*\s+条失败/.test(probeText)) say(false, '探针自身有失败项（见上面的 ✗）')

  const sessionId = /worktreelink\.sessionId=([A-Za-z0-9._-]+)/.exec(probeText)?.[1]
  const worktree = /worktreelink\.worktree=(.+)/.exec(probeText)?.[1]?.trim()
  say(!!sessionId && !!worktree, `探针报告了新会话与工作树（${sessionId} / ${worktree}）`)
  const linkFile = join(sandboxRoot, 'data', 'worktree-links.json')
  if (!existsSync(linkFile)) {
    say(false, `没有找到 ${linkFile}（关系没落盘）`)
  } else {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(linkFile, 'utf8'))
    } catch {
    }
    const item = Array.isArray(parsed?.links) ? parsed.links.find((x) => x?.sessionId === sessionId) : null
    say(!!item, '磁盘上的那条关系就是探针登记的那条（会话 id 对得上）', JSON.stringify(item ?? null))
    if (item) {
      say(item.worktree === worktree, '工作树目录对得上', String(item.worktree))
      say(!!item.fromSessionId, '源会话记下来了（不是一条孤立记录）', String(item.fromSessionId))
      say(item.fromSessionId !== item.sessionId, '源会话与新会话不是同一条（方向没写反）')
      say(Number.isFinite(item.at) && item.at > 0, '带时间戳', String(item.at))
    }
  }

  return { ok, lines }
}

async function checkProjectOpenedLayout(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }
  const text = String(probeText ?? '')
  const openedId = /projectopened\.sessionId=([A-Za-z0-9._-]+)/.exec(text)?.[1]
  say(!!openedId, `探针报告了被打开的会话（${openedId}）`)
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok, lines }
  }
  const file = join(sandboxRoot, 'data', 'session-layout.json')
  if (!existsSync(file)) {
    say(false, `没有找到 ${file}（打开记录没落盘）`)
    return { ok, lines }
  }
  let doc = null
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
  }
  const entries = Array.isArray(doc?.entries) ? doc.entries : null
  say(!!entries, 'session-layout.json 是合法的（有 entries 数组）')
  if (!entries) return { ok, lines }
  const opened = entries.find((e) => e?.sessionId === openedId)
  const hot = entries.find((e) => String(e?.sessionId ?? '').includes('yan-n05-hot'))
  say(!!opened, '被打开的那条在布局索引里')
  if (opened) say(Number.isFinite(opened.lastOpenedAt) && opened.lastOpenedAt > 0, '它的 lastOpenedAt 真的落盘了', String(opened.lastOpenedAt))
  say(!!hot, 'hot 那条也在索引里（对照项没有缺席）')
  if (hot) say(!hot.lastOpenedAt, 'hot 那条没有被写上 lastOpenedAt（没打开过就不该有）', String(hot.lastOpenedAt ?? '无'))
  return { ok, lines }
}

async function checkSourceLocateLinked(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }
  const text = String(probeText ?? '')
  const sid = /sourcelink\.sessionId=([A-Za-z0-9._-]+)/.exec(text)?.[1]
  const messageId = /sourcelink\.messageId=([A-Za-z0-9._:-]+)/.exec(text)?.[1]
  const sourceId = /sourcelink\.sourceId=(image:[A-Za-z0-9._-]+)/.exec(text)?.[1]
  say(!!sid && !!messageId && !!sourceId, `探针报告了定位信息（${sid} / ${messageId} / ${sourceId}）`)
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok, lines }
  }

  const safe = String(sid ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  const hits = []
  const walk = (dir, depth = 0) => {
    if (depth > 6) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name === 'links.json' && full.includes(safe)) hits.push(full)
    }
  }
  walk(sandboxRoot)
  say(hits.length === 1, `磁盘上找得到 links.json（${hits.length} 个）`, hits[0] ?? '')
  if (hits.length === 1) {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(hits[0], 'utf8'))
    } catch {
    }
    say(Array.isArray(parsed), '文件是合法 JSON 数组')
    const item = Array.isArray(parsed) ? parsed.find((x) => x?.sourceId === sourceId) : null
    say(!!item && item.messageId === messageId, '文件里那条关联的 sourceId + messageId 都对得上', JSON.stringify(item))
    say(Array.isArray(parsed) && parsed.length === 1, '只有一条（幂等：重复登记没写第二条）', String(parsed?.length))
  }
  return { ok, lines }
}

function checkExitSnapshot(sandboxRoot, tempBefore, lastProbeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data')
  const file = join(dir, 'exit-snapshot.json')
  const expectMode = /expect-mode=(\w+)/.exec(lastProbeText)?.[1] ?? null
  const probeAt = Number(/probe-at=(\d+)/.exec(lastProbeText)?.[1] ?? 0)
  const runnerCount = Number(/^runners=(\d+)$/m.exec(lastProbeText)?.[1] ?? -1)

  say(!!expectMode, `探针声明了期望的 mode（${expectMode ?? '缺失'}）`)
  say(probeAt > 0, `探针报了自己的时刻（${probeAt || '缺失'}）`)
  if (!existsSync(file)) {
    say(false, '退出快照 exit-snapshot.json 已写下', file)
    return { ok, lines }
  }
  say(true, '退出快照 exit-snapshot.json 已写下')

  let snapshot = null
  try {
    snapshot = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
  }
  if (!snapshot) {
    say(false, '文件是合法 JSON')
    return { ok, lines }
  }

  say(snapshot.version === 1, 'version=1（格式契约）', String(snapshot.version))
  say(
    !!expectMode && snapshot.mode === expectMode,
    `mode 与本次请求一致（期望 ${expectMode}，实际 ${snapshot.mode}）`
  )
  say(
    typeof snapshot.at === 'number' && snapshot.at >= probeAt && snapshot.at - probeAt < 120_000,
    'at 是这次退出写的（探针时刻之后、120s 之内）',
    `at-probe=${(snapshot.at ?? 0) - probeAt}ms`
  )

  const runners = Array.isArray(snapshot.runners) ? snapshot.runners : null
  say(!!runners, 'runners 是数组')
  if (runners) {
    say(
      runnerCount >= 0 && runners.length === runnerCount,
      `runners 条数与窗口里看到的一致（窗口 ${runnerCount} / 快照 ${runners.length}）`
    )
    const shaped = runners.every((r) => r && typeof r.cwd === 'string' && typeof r.conn === 'string' && typeof r.running === 'boolean')
    say(shaped, '每条都带 cwd / conn / running（元数据，不含消息正文）')
    const bodies = JSON.stringify(snapshot)
    say(!/"(content|text|message|messages)"\s*:/.test(bodies), '快照里没有消息正文/消息数组字段')
    lines.push(`    实例：${runners.map((r) => `${r.id}@${r.conn}${r.running ? '(running)' : ''}`).join(' ') || '（空）'}`)
  }

  const temps = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith('exit-snapshot.json.') && f.endsWith('.tmp'))
    : []
  say(temps.length === 0, '没有留下写一半的 .tmp（原子写：tmp → rename）', temps.join(' '))
  return { ok, lines }
}

function checkSubagentFail(sandboxRoot, tempBefore) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'subagents')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const records = []
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
    }
  }
  lines.push(`  元数据 ${records.length} 份：${files.join(' ') || '（空）'}`)

  const run = records.find((r) => String(r.task ?? '').includes('YAN-SUBFAIL'))
  say(!!run, '找到 YAN-SUBFAIL 的归档记录', String(run?.task ?? ''))
  if (run) {
    say(run.status === 'error', `归档里 status=error（实际 ${run.status}）`)
    say(run.review === 'none', `没有改动 → review=none（实际 ${run.review}）`)
    say(run.endedAt > 0 && run.startedAt > 0, '有起止时间（可追溯）')
  }

  const leftovers = readdirSync(tmpdir()).filter(
    (n) => n.startsWith('yan-subagent-') && !(tempBefore ?? new Set()).has(n)
  )
  say(leftovers.length === 0, `退出后没有残留的隔离目录（新增 ${leftovers.length} 个）`, leftovers.join(' '))

  return { ok, lines }
}

const SEED_BEFORE_RESTART = {
  interruptedSnapshot: seedInterruptedSnapshot
}

function seedInterruptedSnapshot(sandboxRoot) {
  if (!sandboxRoot) return '（无沙箱，跳过）'
  const dir = join(sandboxRoot, 'data', 'turn-timing')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  if (!files.length) return '（没有计时日志，跳过）'
  const file = join(dir, files[files.length - 1])
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  if (!lines.length) return '（日志为空，跳过）'
  const last = JSON.parse(lines[lines.length - 1])
  const snapshot = {
    ...last,
    final: false,
    elapsedMs: Math.max(1, Math.round((Number(last.elapsedMs) || 1) * 0.4))
  }
  appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8')
  return `${basename(file)}：追加中途快照（final=false，logicalTurnId=${last.logicalTurnId}）`
}

const AFTER_EXIT = {
  exitSnapshot: checkExitSnapshot,
  remoteRoutes: checkRemoteRoutes,
  subagentFail: checkSubagentFail,
  subagentArchive: checkSubagentArchive,
  knowledgeCli: checkKnowledgeCli,
  knowledgeTab: checkKnowledgeTab,
  knowledgeIsolation: checkKnowledgeIsolation,
  sessionabArchive: checkSessionabArchive,
  atrefsendArchive: checkAtRefSend,
  browserBoundaryDownloads: checkBrowserBoundaryDownloads,
  sourceLocateLinked: checkSourceLocateLinked,
  projectOpenedLayout: checkProjectOpenedLayout,
  gitWriteApplied: checkGitWriteApplied,
  taskFixtureReadonly: checkTaskFixtureReadonly,
  taskCliLog: checkTaskCliLog,
  taskPlanMultiStep: checkTaskPlanMultiStep,
  workModePersisted: checkWorkModePersisted,
  goalPersisted: checkGoalPersisted,
  goalReviewPersisted: checkGoalReviewPersisted,
  goalReviewModifyPersisted: checkGoalReviewModifyPersisted,
  turnTimingPersisted: checkTurnTimingPersisted,
  turnTimingIsolation: checkTurnTimingIsolation,
  turnTimingInterrupted: checkTurnTimingInterrupted,
  turnTimingHardKill: checkTurnTimingHardKill,
  budgetGate: checkBudgetGate,
  questionModeLog: checkQuestionModeLog
}

async function checkQuestionModeLog(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const logFile = join(tmpdir(), 'yan-question-ext.log')
  const records = (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  lines.push(`  诊断行数 = ${records.length}`)
  for (const r of records.slice(0, 12)) {
    lines.push(`    ${r.hook} mode=${r.mode} sid=${r.sessionId ?? '-'}`)
  }
  say(records.length >= 1, '扩展真的被调用并写下模式')
  say(
    records.some((r) => r.mode === 'autonomous'),
    '自主档真的到达扩展（不靠 defaultWorkMode 猜）'
  )
  say(
    records.some((r) => r.hook === 'before_agent_start' && r.mode === 'autonomous'),
    '自主档真的经过 question.js 的工作模式提示钩子'
  )
  say(!records.some((r) => r.hook === 'execute'), 'question.js 没有恢复旧的模型工具 execute 钩子')
  return { ok, lines }
}

async function checkWorkModePersisted(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'work-modes.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(`  work-modes.json 条目：${entries.map(([k, v]) => `${k}=${v.mode}(rev${v.revision})`).join(', ')}`)
    say(entries.length >= 2, `至少两个会话各自存了一份（实际 ${entries.length}）`)
    say(entries.some(([, v]) => v.mode === 'autonomous'), '存下了自主模式（A 会话）')
    say(entries.some(([, v]) => v.mode === 'clarify'), '存下了计划模式（B 会话）')
    say(entries.every(([, v]) => Number.isFinite(v.revision) && v.revision >= 1), '每条都有 revision（提交过）')
  } catch (error) {
    say(false, '读 work-modes.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const snapDir = join(dataDir, 'work-mode')
    const files = readdirSync(snapDir).filter((n) => n.endsWith('.json'))
    lines.push(`  work-mode/ 快照：${files.join(', ') || '(空)'}`)
    say(files.length >= 1, '写了至少一份模型侧快照')
    const records = files.map((n) => JSON.parse(readFileSync(join(snapDir, n), 'utf8')))
    say(
      records.every((r) => ['standard', 'clarify', 'autonomous'].includes(r?.mode)),
      '每份快照的 mode 都是合法值（扩展读它决定提不提问）'
    )
    say(
      records.some((r) => r.mode === 'clarify') || records.some((r) => r.mode === 'autonomous'),
      '快照内容跟随会话（不是一直停在默认值）'
    )
  } catch (error) {
    say(false, '读 work-mode/ 快照失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const settings = JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8'))
    say(settings.autonomous === true, '旧 autonomous 原样留在磁盘上（不抹掉用户已写下的值）')
    say(
      settings.defaultWorkMode === 'autonomous',
      '迁移结果随写入固化到新字段（与旧值语义相同，幂等）'
    )
    say(!('workModeShortcutEnabled' in settings) && !('workModeShortcut' in settings), '关掉再打开的快捷键不落盘（默认态无键）')
  } catch (error) {
    say(false, '读 desktop.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  return { ok, lines }
}

let taskFixtureBaseline = null

function captureSessionFile(sessionsRoot, needle) {
  const found = []
  const walk = (dir, depth = 0) => {
    if (depth > 3) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name.endsWith('.jsonl') && e.name.includes(needle)) found.push(p)
    }
  }
  walk(sessionsRoot)
  if (!found[0]) return null
  return { path: found[0], text: readFileSync(found[0], 'utf8') }
}

async function checkTaskFixtureReadonly() {
  const lines = []
  if (!taskFixtureBaseline) {
    return { ok: false, lines: ['✗ 没有会话只读基线（场景里没找到 fixture 会话）'] }
  }
  let after = ''
  try {
    after = readFileSync(taskFixtureBaseline.path, 'utf8')
  } catch (err) {
    return { ok: false, lines: [`✗ 读不到基线会话文件：${err.message}`] }
  }
  let ok = true
  lines.push(
    `基线：${basename(taskFixtureBaseline.path)}（${Buffer.byteLength(taskFixtureBaseline.text)} 字节）`
  )
  if (after.startsWith(taskFixtureBaseline.text)) {
    lines.push('✓ 原有内容逐字节不变（只允许在末尾追加）')
  } else {
    ok = false
    lines.push('✗ 原有内容被改写了（前缀不一致）—— 契约要求历史文件不回写、不批量转换')
  }
  const added = after.slice(taskFixtureBaseline.text.length)
  const addedLines = added.split('\n').filter(Boolean)
  lines.push(`追加 ${addedLines.length} 行：`)
  for (const l of addedLines.slice(0, 5)) lines.push(`  · ${l.slice(0, 200)}`)
  const taskWrites = addedLines.filter(
    (l) => l.includes('left-panel-tasks') || l.includes('yan-task-plan')
  )
  if (taskWrites.length) {
    ok = false
    lines.push(`✗ 追加里出现了任务快照条目（${taskWrites.length} 条）—— 砚不应替模型伪造任务写入`)
  } else {
    lines.push('✓ 追加里没有任务快照条目（没有伪造任务写入）')
  }
  return { ok, lines }
}

async function checkTurnTimingPersisted(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const liveMs = Number(/turn-timing\.liveElapsedMs=(\d+)/.exec(probeText)?.[1] ?? 0)
  const dir = join(sandboxRoot, 'data', 'turn-timing')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`  目录 = ${dir}`)
  lines.push(`  文件 = ${JSON.stringify(files)}`)
  say(files.length >= 1, `至少一个会话的计时日志（${files.length}）`)

  const records = []
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
      }
    }
  }
  say(records.length >= 1, `至少一条记录（${records.length}）`)
  const last = records[records.length - 1]
  say(last?.v === 1, `记录带版本号（v=${last?.v}）`)
  say(Number(last?.elapsedMs) > 0, `记录里的用时是正数（${last?.elapsedMs}ms）`)
  if (liveMs > 0 && last) {
    say(
      Math.abs(Number(last.elapsedMs) - liveMs) <= Math.max(1500, liveMs * 0.2),
      `落盘用时与界面一致（${last.elapsedMs} ≈ ${liveMs}）`
    )
  }
  say(
    Array.isArray(last?.sourceIds) && last.sourceIds.length >= 1,
    '记录带归属消息 id（否则读回来不知道该挂给哪个回合）'
  )
  const expectedReason = /turn-timing\.expectedReason=(\w+)/.exec(probeText)?.[1] ?? ''
  say(
    ['completed', 'failed', 'stopped', 'interrupted'].includes(String(last?.terminalReason)),
    `终止原因是四个合法值之一（实际 ${last?.terminalReason}）`
  )
  say(last?.final === true, `收尾记录带 final: true（实际 ${String(last?.final)}）`)
  say(/^m\d+$/.test(String(last?.anchorId ?? '')), `记录锚定用户消息 id（${last?.anchorId}）`)
  say(
    last?.logicalTurnId === last?.anchorId,
    `逻辑回合身份 = 用户消息 id（${last?.logicalTurnId}）`
  )
  say(
    typeof last?.runId === 'string' && String(last.runId).startsWith('run-'),
    `记录带 runId（${last?.runId}）`
  )
  if (expectedReason) {
    say(
      last?.terminalReason === expectedReason,
      `终止原因与界面一致（${last?.terminalReason} vs ${expectedReason}）`
    )
  }

  const extLog = join(sandboxRoot, 'ctx-ext.log')
  const rows = existsSync(extLog)
    ? readFileSync(extLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    : []
  const budgetRows = rows.filter((r) => String(r?.hook ?? '').startsWith('request-budget-'))
  const v1Dir = join(sandboxRoot, 'data', 'context-budget-v1')
  const v1Active = existsSync(v1Dir) && readdirSync(v1Dir).length > 0
  const skipTrace = v1Active && budgetRows.length === 0
  const row = budgetRows[budgetRows.length - 1]
  if (skipTrace) {
    lines.push('  ⤺ 会话走预算 V1，旧路径的估算留痕不适用，跳过留痕断言')
    return { ok, lines }
  }
  say(budgetRows.length >= 1, `真实请求里有估算留痕（${budgetRows.length} 行）`)
  if (row) {
    lines.push(
      `  估算 = messages ${row.messages} + tools ${row.tools} + system ${row.system} = ${row.estimatedTokens}`
    )
    say(
      row.messages > 0 && row.tools > 0,
      'messages 与 tools 都估到了（工具表不是 0）'
    )
    lines.push(`  system 段 = ${row.system}（pi 把它放在 messages 里时为 0，属于正常）`)
    say(
      row.estimatedTokens === row.messages + row.tools + row.system,
      '估算总和 = 三部分之和（不是各算各的）'
    )
    say(
      row.projectedTokens === row.estimatedTokens + row.responseReserve,
      `预测量 = 估算 + 输出预留（${row.projectedTokens} = ${row.estimatedTokens} + ${row.responseReserve}）`
    )
    say(row.window > 0 && row.workingSet > 0, `留痕里带着当时的预算线（工作集 ${row.workingSet} / 窗口 ${row.window}）`)
  } else {
    say(false, '没有 request-budget-* 行（扩展可能没跑到 before_provider_request）')
  }

  return { ok, lines }
}

async function checkTurnTimingIsolation(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  let snapshot = null
  try {
    const raw = /^\s*turn-timing-isolation\.snapshot=(.+)$/m.exec(probeText)?.[1]
    snapshot = raw ? JSON.parse(raw) : null
  } catch {
    snapshot = null
  }
  say(!!snapshot?.a && !!snapshot?.b, '探针保存 A / B 的实际 sessionFile、用户锚点和读回消息 id')

  const dir = join(sandboxRoot, 'data', 'turn-timing')
  const checkSession = (tag) => {
    const entry = snapshot?.[tag]
    const expectedUserId = entry?.userId
    const fileName = entry?.sessionFile ? `${basename(entry.sessionFile).replace(/\.jsonl$/i, '')}.jsonl` : ''
    const path = fileName ? join(dir, fileName) : ''
    let records = []
    if (path && existsSync(path)) {
      records = readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    }
    say(!!path && existsSync(path), `${tag.toUpperCase()} 写入自己的计时文件（${fileName || '缺少 sessionFile'}）`)
    say(/^m\d+$/.test(String(expectedUserId ?? '')), `${tag.toUpperCase()} 读回用户锚点（${expectedUserId ?? '缺失'}）`)
    const matching = records.filter((record) => record?.logicalTurnId === expectedUserId)
    say(matching.length >= 1, `${tag.toUpperCase()} 的分桶包含自己的逻辑回合（${matching.length} 条快照）`)
    const final = matching.filter((record) => record.final === true).at(-1)
    const latest = matching.at(-1)
    lines.push(`  ${tag.toUpperCase()} 最近快照 = ${JSON.stringify(latest ? { final: latest.final, terminalReason: latest.terminalReason, elapsedMs: latest.elapsedMs, runId: latest.runId } : null)}`)
    say(!!final, `${tag.toUpperCase()} 有终止快照`)
    say(latest?.final === true, `${tag.toUpperCase()} 的最新快照就是终止快照（final=${String(latest?.final)}）`)
    if (!final) return null
    say(final.anchorId === expectedUserId, `${tag.toUpperCase()} 的落盘锚点仍指向本会话的用户消息`)
    say(final.terminalReason === 'completed', `${tag.toUpperCase()} 回合正常完成（${final.terminalReason}）`)
    say(
      Array.isArray(final.sourceIds) && final.sourceIds.length >= 1,
      `${tag.toUpperCase()} 收尾记录保留运行时 sourceIds（${JSON.stringify(final.sourceIds ?? [])}）`
    )
    say(
      (entry?.timedAssistantIds ?? []).length >= 1,
      `${tag.toUpperCase()} 的计时呈现在重读后的本回合助手回复上（${JSON.stringify(entry?.timedAssistantIds ?? [])}）`
    )
    return final
  }

  const a = checkSession('a')
  const b = checkSession('b')
  if (a && b) {
    say(
      !!a.runId && !!b.runId && a.runId !== b.runId,
      `A、B 两个 runner 各有自己的 runId（${a.runId} / ${b.runId}）`
    )
    say(
      Number(b.elapsedMs) > Number(a.elapsedMs) + 2500,
      `不同 fixture 延迟仍按会话归属（A=${a.elapsedMs}ms，B=${b.elapsedMs}ms）`
    )
  }
  say(
    Number(handoffFailureState?.maxConcurrent ?? 0) >= 2,
    `本机 provider 确认两条请求曾同时在途（最大并发 ${handoffFailureState?.maxConcurrent ?? 0}）`
  )
  say(Number(handoffFailureState?.turnRequests ?? 0) >= 2, `本机 provider 收到两条回合请求（${handoffFailureState?.turnRequests ?? 0}）`)
  return { ok, lines }
}

async function checkTurnTimingInterrupted(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'turn-timing')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`  目录 = ${dir}`)
  const records = []
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
      }
    }
  }
  const last = records[records.length - 1]
  const realHardKill = String(probeText).includes('turn-timing.hardkill.processExitedAfterForce=true')
  lines.push(`  turn-timing.disk.records=${JSON.stringify(records)}`)
  say(
    realHardKill ? records.length === 1 : records.length >= 2,
    realHardKill
      ? `真强杀后磁盘只保留中途快照（${records.length} 条）`
      : `同一回合有收尾 + 中途两条记录（${records.length}）`
  )
  say(last?.final === false, `盘上最后一条是中途快照（final=${String(last?.final)}）`)

  const { pathToFileURL } = await import('node:url')
  const store = await import(pathToFileURL(join(root, 'out/test/turn-timing-store.mjs')).href)
  say(
    store.effectiveTerminalReason(last) === 'interrupted',
    `中途快照被归一为「中断」（${store.effectiveTerminalReason(last)}）`
  )

  const uiReason = /turn-timing\.interrupted\.reason=(\w+)/.exec(probeText)?.[1]
  say(uiReason === 'interrupted', `重启后的探针从 peeking 的历史里读到「中断」（${uiReason}）`)
  const footer = /turn-timing\.interrupted\.footer=("[^\n]*")/.exec(probeText)?.[1]
  say(/中断/.test(footer ?? ''), `真实页脚里写出「已中断」（${footer}）`)
  return { ok, lines }
}

async function checkTurnTimingHardKill(sandboxRoot, tempBefore, probeText = '') {
  const base = await checkTurnTimingInterrupted(sandboxRoot, tempBefore, probeText)
  const lines = [...base.lines]
  let ok = base.ok
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  const text = String(probeText)
  say(text.includes('turn-timing.hardkill.processExitedAfterForce=true'), '隔离 Electron 在强制终止请求后退出')
  say(text.includes('turn-timing.hardkill.snapshot='), '父进程输出了强杀前读到的完整快照')
  say(text.includes('turn-timing.interrupted.userMarkerPresent=true'), '重启后从同一测试会话读到唯一用户标记')
  say(text.includes('turn-timing.interrupted.toolCallPresent=true'), '重启后会话保留了触发中途快照的 bash tool call')
  say(handoffFailureState?.failureMode === 'turn-timing-kill', '场景使用隔离的本机 fixture provider')
  say(handoffFailureState?.bashToolOffered === true && handoffFailureState?.toolCallSent === true, 'fixture 确认收到工具 schema 并返回 bash tool call')
  say(handoffFailureState?.followupHeld === true, 'pi 已执行工具并发出第二次模型请求，该请求仍在途时才强杀')
  say(Number(handoffFailureState?.turnRequests ?? 0) === 2, `本机 provider 收到首轮工具调用与第二轮续接请求（${handoffFailureState?.turnRequests ?? 0}）`)
  return { ok, lines }
}

async function checkGoalPersisted(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')
  const short = (key) => String(key).split(/[\\/]/).pop()

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'goals.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(
      `goals.json 条目：${entries.map(([k, v]) => `${short(k)}=${v?.goal?.phase}(rev${v?.goal?.revision})`).join(', ') || '（空）'}`
    )
    say(entries.length === 1, `恰好一条会话记录（实际 ${entries.length}）`)
    const entry = entries[0]?.[1]
    say(entry?.goal?.phase === 'executing', `目标已进入 executing（实际 ${entry?.goal?.phase}）`)
    say(entry?.goal?.revision === 1, `目标只推进过一次（实际 rev${entry?.goal?.revision}）`)
    const transitions = Object.entries(entry?.transitions ?? {})
    say(transitions.length === 1, `就绪转移只记了一条（实际 ${transitions.length}）`)
    say(String(transitions[0]?.[0] ?? '') === 'tr-probe-1', `幂等键就是探针给的那个（${transitions[0]?.[0] ?? '无'}）`)
    const understanding = transitions[0]?.[1]?.result?.understanding ?? {}
    say(String(understanding.acceptance ?? '').includes('CSV'), '五栏（含验收标准）真的传到了宿主')
    say(transitions[0]?.[1]?.result?.mode === 'standard', '转移记录里写着「模式切标准」')

    say(
      !entry?.goal?.verification,
      `G-2：只做了 ready（没 report）→ 没有核验结论（实际 ${entry?.goal?.verification?.status ?? 'null'}）`
    )

    const sessionFile = String(entries[0]?.[0] ?? '')
    if (sessionFile && existsSync(sessionFile)) {
      const text = readFileSync(sessionFile, 'utf8')
      say(text.includes('"customType":"yan-goal-resume"'), '会话里有续行的消费证据条目（yan-goal-resume）')
      say(text.includes('"customType":"yan-goal-ready"'), '会话里有那条控制消息（yan-goal-ready，角色不是 user）')
      const role = /"customType":"yan-goal-ready"[^}]*/.exec(text)?.[0] ?? ''
      say(!role.includes('"role":"user"'), '控制消息不是伪造的用户消息')
    } else {
      say(false, '从 goals.json 的键找不到会话文件：' + (sessionFile || '（无）'))
    }
  } catch (error) {
    say(false, '读 goals.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'work-modes.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(
      `work-modes.json 条目：${entries.map(([k, v]) => `${short(k)}=${v.mode}(rev${v.revision})`).join(', ') || '（空）'}`
    )
    say(entries.some(([, v]) => v.mode === 'standard'), '磁盘上的模式已是标准（就绪转移的另一半）')
    say(
      entries.some(([, v]) => Number.isFinite(v.revision) && v.revision >= 2),
      '模式 revision 至少推进两次（切计划 + 就绪切标准）'
    )
  } catch (error) {
    say(false, '读 work-modes.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const dir = join(dataDir, 'goal-resume')
    const files = existsSync(dir) ? readdirSync(dir) : []
    lines.push(`goal-resume/ 快照：${files.join(', ') || '（空）'}`)
    for (const name of files) {
      if (!name.endsWith('.json')) continue
      const rec = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      lines.push(`    ${name}: operationId=${rec?.operationId ?? '(null)'}`)
    }
    say(files.includes('r1.json'), '写了续行快照（按 runnerId 命名，扩展据此判断）')
  } catch (error) {
    say(false, '读 goal-resume/ 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  const resumeLog = join(tmpdir(), 'yan-goal-resume.log')
  if (existsSync(resumeLog)) {
    const rows = readFileSync(resumeLog, 'utf8').trim().split('\n').filter(Boolean)
    lines.push(`  续行扩展诊断（${rows.length} 行）：`)
    for (const row of rows.slice(-6)) lines.push('    ' + row)
  } else {
    lines.push('  续行扩展诊断：没有文件（扩展没跑过 message_end，或没开日志）')
  }

  return { ok, lines }
}

async function checkGoalReviewPersisted(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dataDir = join(sandboxRoot, 'data')
  const short = (key) => String(key).split(/[\\/]/).pop()
  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'goals.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    say(entries.length === 1, `只有当前测试会话的目标记录（实际 ${entries.length}）`)
    const [sessionFile, entry] = entries[0] ?? []
    const goal = entry?.goal
    say(goal?.phase === 'executing', `批准后的目标已落盘为 executing（${goal?.phase ?? '无'}）`)
    say(!goal?.pendingReady, '已批准目标不再保留待审计划')
    say(goal?.readyApproval === 'review', '会话的审阅偏好仍为 review')
    const transitions = Object.entries(entry?.transitions ?? {})
    say(transitions.length === 1, `只提交一次 ready transition（实际 ${transitions.length}）`)
    const [transitionId, record] = transitions[0] ?? []
    say(transitionId === 'tr-review-probe-1', `转移使用探针给出的幂等键（${transitionId ?? '无'}）`)
    say(
      record?.result?.phase === 'executing' && record?.result?.mode === 'standard',
      '转移记录同时提交 executing 与 standard'
    )
    say(String(record?.result?.understanding?.acceptance ?? '').includes('CSV'), '批准记录保留用户可审阅的验收字段')

    if (sessionFile && existsSync(sessionFile)) {
      const text = readFileSync(sessionFile, 'utf8')
      say(text.includes('yan goal ready'), '真实会话中保存了模型经 bash 提交的 ready 命令')
      say(text.includes('请按刚才批准的计划开始执行。'), '真实会话中保存了主进程发送的启动消息')
    } else {
      say(false, `找不到会话文件（${short(sessionFile ?? '') || '无'}）`)
    }
  } catch (error) {
    say(false, `读 goals.json 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'work-modes.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    say(
      entries.some(([, mode]) => mode?.mode === 'standard' && Number(mode.revision) >= 2),
      `批准后的模式为 standard 且 revision 至少为 2（${entries.map(([key, mode]) => `${short(key)}=${mode.mode}(rev${mode.revision})`).join(', ') || '空'}）`
    )
  } catch (error) {
    say(false, `读 work-modes.json 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  say(String(probeText).includes('批准 IPC 向当前 runner 发送了计划启动消息'), 'live 探针确认批准后启动消息已到达当前 runner')
  return { ok, lines }
}

async function checkGoalReviewModifyPersisted(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')
  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'goals.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    const modified = entries.filter(([, entry]) =>
      entry?.goal?.goalId === 'goal-review-modify-fixture' && entry.goal.pendingReady == null
    )
    say(entries.length > 0, `读取到隔离目标条目（${entries.length}）`)
    say(modified.length === 1, `只有当前会话清除了待审计划（${modified.length} 条）`)
    const [sessionFile, entry] = modified[0] ?? []
    say(entry?.goal?.phase === 'planning', `修改后仍处于 planning（${entry?.goal?.phase ?? '无'}）`)
    say(entry?.goal?.revision === 4, `清除待审快照只推进一次 revision（${entry?.goal?.revision ?? '无'}）`)
    say(entry?.goal?.readyApproval === 'review', '修改后保留 per-session review 偏好')
    say(Object.keys(entry?.transitions ?? {}).length === 0, '修改没有提交 ready transition')
    if (sessionFile && existsSync(sessionFile)) {
      const text = readFileSync(sessionFile, 'utf8')
      say(!text.includes('请按刚才批准的计划开始执行。'), '会话文件里没有误发批准后的启动消息')
    } else {
      say(false, '修改目标对应的会话文件存在')
    }
  } catch (error) {
    say(false, `读 goals.json 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'work-modes.json'), 'utf8'))
    const modes = Object.values(doc?.entries ?? {})
    say(modes.some((mode) => mode?.mode === 'clarify' && mode.revision === 1), '修改后仍留在只读计划模式')
  } catch (error) {
    say(false, `读 work-modes.json 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  say(String(probeText).includes('G-4 修改经真实 IPC 撤销待审快照'), 'live 探针确认修改按钮经过主进程并撤销待审状态')
  return { ok, lines }
}

async function checkBudgetGate(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const budgetRows = records.filter((r) => String(r?.hook ?? '').startsWith('request-budget-'))
  lines.push(`  诊断行 = ${records.length}（其中请求前预算 ${budgetRows.length} 行）`)
  say(budgetRows.length >= 1, '请求前预算诊断真的记了（钩子在真实链路里跑起来了）')
  for (const row of budgetRows) {
    lines.push(
      `    ${row.hook}：messages ${row.messages} + tools ${row.tools} + system ${row.system} = 估算 ${row.estimatedTokens} ` +
        `/ 工作集 ${row.workingSet} / 窗口 ${row.window} / 预留 ${row.responseReserve}`
    )
  }
  const soft = budgetRows.filter((r) => r.hook === 'request-budget-soft')
  say(soft.length >= 1, '工作集线压到 3000 后，真实对话到了 soft')
  const physical = budgetRows.filter((r) => r.hook === 'request-budget-physical')
  say(physical.length === 0, '没有误判 physical（真实窗口下不该拦）')
  const aborted = records.filter((r) => r.hook === 'budget-abort')
  say(aborted.length === 0, '没有 abort（真实请求照常发出）')

  const sessionId = budgetRows.find((r) => r.sessionId)?.sessionId ?? null
  const sessionsDir = join(sandboxRoot, 'sessions')
  let usageInput = null
  if (sessionId && existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.jsonl') && f.includes(sessionId))
    if (files.length) {
      const rows = readFileSync(join(sessionsDir, files[files.length - 1]), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
      for (const row of rows) {
        const usage = row?.message?.usage
        if (row?.message?.role === 'assistant' && Number(usage?.input) > 0) usageInput = Number(usage.input)
      }
    }
  }
  const estimate = budgetRows.length ? Number(budgetRows[budgetRows.length - 1].estimatedTokens) : 0
  if (usageInput == null) {
    lines.push('  · 没读到真实 usage.input（本轮模型可能返回空）：只核对诊断，不比数字')
  } else {
    lines.push(`  参考：估算 ${estimate} / 真实 usage.input ${usageInput}（不判红，空回复时不可比）`)
  }

  return { ok, lines }
}

async function checkTaskCliLog(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const text = String(probeText ?? '')
  const sid = /taskcli\.sessionId=([0-9A-Za-z._-]+)/.exec(text)?.[1] ?? ''
  const sessionFile = /taskcli\.sessionFile=(.+)/.exec(text)?.[1]?.trim() ?? ''
  const dir = join(sandboxRoot, 'data', 'task-plans')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`任务日志目录：${files.length ? files.join('、') : '（空）'}；会话 id = ${sid || '（探针没报）'}`)

  say(!!sid && files.includes(`${sid}.jsonl`), '日志按会话 id 命名（不是 runner id / 时间戳）')
  say(
    files.every((f) => /^[0-9A-Za-z._-]+\.jsonl$/.test(f)),
    '文件名都是合法会话 id（没有 pending: / 路径分隔符）'
  )

  const path = sid ? join(dir, `${sid}.jsonl`) : null
  const raw = path && existsSync(path) ? readFileSync(path, 'utf8') : ''
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
  const bad = rows.filter((r) => r === null).length
  const valid = rows.filter(Boolean)
  say(bad === 0, `没有写坏的行（坏行 ${bad} 条）`)
  say(valid.length === 2, `两次提交写了两行（实际 ${valid.length} 行）`)
  say(
    valid.every((r) => r.data?.schemaVersion === 1),
    '每行都带 schemaVersion = 1（读回来判版本用）'
  )
  say(
    valid[0]?.data?.revision === 1 && valid[1]?.data?.revision === 2,
    `revision 从 1 递增到 2（实际 ${valid.map((r) => r.data?.revision).join(' → ')}）`
  )
  say(
    !!valid[0]?.data?.operationId && valid[0].data.operationId !== valid[1]?.data?.operationId,
    '两次提交各有自己的 operationId（幂等键随提交变化）'
  )
  say(valid[0]?.data?.todos?.length === 3, `第一行是三项（实际 ${valid[0]?.data?.todos?.length}）`)
  say(valid[1]?.data?.todos?.[1]?.done === true, '第二行第 2 项已完成（complete 真的落盘了）')
  say(
    valid.every((r) => Number.isInteger(r.round) && r.round >= 1),
    '每行都记了轮次（历史分组靠它）'
  )
  say(valid.every((r) => typeof r.at === 'string' && r.at.length > 0), '每行都有提交时间')

  if (sessionFile && existsSync(sessionFile)) {
    const sessionText = readFileSync(sessionFile, 'utf8')
    say(
      !sessionText.includes('yan-task-plan'),
      '会话 JSONL 里没有被写入任务条目（宿主日志在砚自己的目录）'
    )
    say(
      !sessionText.includes('left-panel-tasks'),
      '也没有旧标识的任务条目（本场景没有旧扩展）'
    )
  } else {
    lines.push('（探针没报会话文件路径，跳过会话 JSONL 检查）')
  }

  return { ok, lines }
}

async function checkTaskPlanMultiStep(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const text = String(probeText ?? '')
  const sid = /taskplan\.sessionId=([0-9A-Za-z._-]+)/.exec(text)?.[1] ?? ''
  const sessionFile = /taskplan\.sessionFile=(.+)/.exec(text)?.[1]?.trim() ?? ''
  const todoLine = text.split(/\r?\n/).find((l) => l.startsWith('taskplan.todos=')) ?? ''
  let uiTodos = []
  try {
    const parsed = JSON.parse(todoLine.slice('taskplan.todos='.length))
    if (Array.isArray(parsed)) uiTodos = parsed
  } catch {
    uiTodos = []
  }

  const tasksDir = join(sandboxRoot, 'fixture-project', 'tasks')
  const steps = [1, 2, 3].map((n) => join(tasksDir, `step-${n}.txt`))
  const made = steps.filter((p) => existsSync(p))
  const nonEmpty = made.filter((p) => readFileSync(p, 'utf8').trim().length > 0)
  lines.push(`真实文件：` + `tasks/step-*.txt 存在 ${made.length}/3（非空 ${nonEmpty.length}）`)
  say(made.length >= 2, '模型真的建了文件（多步任务确实执行了，不是只登记计划）')
  say(nonEmpty.length === made.length, '建出来的文件都有内容（不是空文件占位）')

  const dir = join(sandboxRoot, 'data', 'task-plans')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`任务日志：${files.length ? files.join('、') : '（空）'}；会话 id = ${sid || '（探针没报）'}`)
  say(!!sid && files.includes(`${sid}.jsonl`), '日志按会话 id 命名')

  const path = sid ? join(dir, `${sid}.jsonl`) : null
  const raw = path && existsSync(path) ? readFileSync(path, 'utf8') : ''
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
  const bad = rows.filter((r) => r === null).length
  const valid = rows.filter(Boolean)
  say(bad === 0, `没有写坏的行（坏行 ${bad} 条）`)
  say(valid.length >= 2, `模型自主提交了 ${valid.length} 次（登记 + 勾选）`)
  const revisions = valid.map((r) => r.data?.revision)
  const increasing = revisions.every((v, i) => (i === 0 ? v === 1 : v === revisions[i - 1] + 1))
  say(increasing, `revision 逐次 +1（实际 ${revisions.join(' → ')}）`)
  say(valid.every((r) => r.data?.schemaVersion === 1), '每行都带 schemaVersion = 1')

  const last = valid[valid.length - 1]
  const diskTodos = Array.isArray(last?.data?.todos) ? last.data.todos : []
  lines.push('  磁盘最后一行 todos = ' + JSON.stringify(diskTodos.map((t) => ({ text: t.text, done: t.done }))))
  say(diskTodos.length === 3, `日志最后一行是 3 条（实际 ${diskTodos.length}）`)

  say(
    JSON.stringify(uiTodos.map((t) => t.text)) === JSON.stringify(diskTodos.map((t) => t.text)),
    '界面清单与磁盘日志的文字逐条一致（不是各显示一套）',
    uiTodos.length ? '' : '（探针没报 todos，比对不可信）'
  )
  say(
    JSON.stringify(uiTodos.map((t) => !!t.done)) === JSON.stringify(diskTodos.map((t) => !!t.done)),
    '勾选状态也一致'
  )
  say(
    diskTodos.every((t) => typeof t.text === 'string' && t.text.trim().length > 0),
    '日志里每条都有非空文字（没有空条目）'
  )

  if (sessionFile && existsSync(sessionFile)) {
    const sessionText = readFileSync(sessionFile, 'utf8')
    say(
      !sessionText.includes('yan-task-plan'),
      '会话 JSONL 里没有被写入任务条目（宿主日志在砚自己的目录）'
    )
    say(!sessionText.includes('left-panel-tasks'), '也没有旧标识的任务条目（本场景没有旧扩展）')
  } else {
    lines.push('（探针没报会话文件路径，跳过会话 JSONL 检查）')
  }

  return { ok, lines }
}

function orphanPiProcesses() {
  if (process.platform !== 'win32') return null
  const script = [
    '$all = Get-CimInstance Win32_Process',
    '$ids = @{}',
    'foreach ($p in $all) { $ids[[int]$p.ProcessId] = 1 }',
    'foreach ($p in $all) {',
    "  if ($p.CommandLine -and $p.CommandLine -match '--mode\\s+rpc') {",
    '    if (-not $ids.ContainsKey([int]$p.ParentProcessId)) {',
    '      "ORPHAN pid=$($p.ProcessId) parent=$($p.ParentProcessId)"',
    '    }',
    '  }',
    '}'
  ].join('; ')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true
    })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('ORPHAN'))
  } catch {
    return null
  }
}

const BOUNDARY_PORT = 39873
const BOUNDARY_ORIGIN = `http://127.0.0.1:${BOUNDARY_PORT}`
const REMOTE_ROUTE_API_PORT = 37893
const REMOTE_ROUTE_TOKEN = 'yan-remote-route-probe-token-2026'
let remoteRouteProbeState = null
let handoffFailureState = null
const BOUNDARY_SECRET = `yan-probe-cookie-${Date.now()}`

function startRemoteRouteProvider() {
  const state = {
    requests: 0,
    canceledStreams: 0,
    completedStreams: 0,
    targetRequests: 0,
    canceledTargetStreams: 0,
    completedTargetStreams: 0,
    responses: new Set()
  }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (part) => (raw += part))
    req.on('end', () => {
      state.requests++
      const isTargetRequest = raw.includes('Reply briefly. This is an isolated local route test; do not use tools.')
      if (isTargetRequest) state.targetRequests++
      try {
        const payload = JSON.parse(raw)
        state.models ??= []
        state.models.push(payload.model)
      } catch {
        state.invalidBodies = (state.invalidBodies ?? 0) + 1
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      state.responses.add(res)
      res.write(
        `data: ${JSON.stringify({
          id: 'remote-route-probe',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'route-probe',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'local route fixture' }, finish_reason: null }]
        })}\n\n`
      )
      const finish = setTimeout(() => {
        if (res.destroyed) return
        state.completedStreams++
        if (isTargetRequest) state.completedTargetStreams++
        res.end('data: [DONE]\n\n')
      }, 60_000)
      finish.unref()
      res.on('close', () => {
        clearTimeout(finish)
        state.responses.delete(res)
        if (!res.writableFinished) {
          state.canceledStreams++
          if (isTargetRequest) state.canceledTargetStreams++
        }
      })
    })
  })
  server.unref()
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('远程路由本机 provider 未分配 TCP 端口'))
        return
      }
      remoteRouteProbeState = state
      resolvePromise({ server, port: address.port, state })
    })
  })
}

async function closeRemoteRouteProvider(provider) {
  if (!provider) return
  for (const response of provider.state.responses) response.destroy()
  await new Promise((resolvePromise) => provider.server.close(() => resolvePromise()))
}

function startHandoffFailureProvider(failureMode = 'invalid-json') {
  const successReceiptFixture = failureMode === 'handoff-start-receipt'
  const reportCommand = 'yan goal report --report-id rp-commit-1 --phase executing --goal-revision 0'
  const handoffPackage = JSON.stringify({
    goal: '在隔离 Electron 中验证交接启动回执。',
    deliverable: '目的片段收到一条 handoff custom 消息并开始 provider 请求。',
    constraints: ['仅使用本机假 provider。'],
    acceptance: ['同 operationId 有 before_provider_request 回执。'],
    done: ['本机 provider 完成了首次目标报告。'],
    remaining: ['确认目的片段的启动回执。'],
    nextActions: ['确认回执后停止目标。'],
    blockers: [],
    files: [],
    notes: []
  })
  const state = {
    failureMode,
    requests: 0,
    turnRequests: 0,
    handoffRequests: 0,
    handoffFailureResponses: 0,
    handoffFailureStatus: 0,
    handoffFailureBody: '',
    activeRequests: 0,
    maxConcurrent: 0,
    promptTokensLast: 0,
    reportToolSent: false,
    responses: new Set()
  }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (part) => (raw += part))
    req.on('end', async () => {
      state.requests++
      let promptChars = 0
      let wantsStream = true
      let payload = null
      try {
        payload = JSON.parse(raw)
        promptChars = JSON.stringify(payload.messages ?? []).length
        wantsStream = payload?.stream !== false
      } catch {
      }
      const hasHandoffPrompt = raw.includes('跨会话交接')
      const isHandoff =
        hasHandoffPrompt &&
        (!successReceiptFixture || !Array.isArray(payload?.tools) || payload.tools.length === 0)
      if (isHandoff) state.handoffRequests++
      else {
        state.turnRequests++
        state.activeRequests++
        state.maxConcurrent = Math.max(state.maxConcurrent, state.activeRequests)
      }
      state.promptTokensLast = Math.ceil(promptChars / 2)
      if (failureMode === 'provider-http-failure' && isHandoff) {
        state.handoffFailureResponses++
        state.handoffFailureStatus = 503
        state.handoffFailureBody = 'fixture_handoff_provider_unavailable'
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          error: {
            message: state.handoffFailureBody,
            type: 'server_error',
            code: state.handoffFailureBody
          }
        }))
        return
      }
      const timingTag = raw.includes('YAN_TIMING_ISOLATION_B') ? 'B' : 'A'
      const timingFixture = failureMode === 'turn-timing' || failureMode === 'turn-timing-kill'
      const responseModel = timingFixture
        ? 'turn-timing-isolation-fixture'
        : successReceiptFixture
          ? 'handoff-start-receipt-fixture'
          : 'handoff-fail-fixture'
      const shouldSendReportTool =
        successReceiptFixture && !isHandoff && !state.reportToolSent && raw.includes(reportCommand)
      const text = failureMode === 'subagent-normal'
        ? '本机子代理 fixture：任务已收到。'
        : failureMode === 'turn-timing'
        ? `TURN_TIMING_ISOLATION_REPLY_${timingTag}`
        : failureMode === 'turn-timing-kill'
          ? 'H6B_TIMING_KILL_FIXTURE_REPLY'
        : successReceiptFixture
          ? isHandoff
            ? handoffPackage
            : '本机 handoff 回执 fixture 已完成。'
        : isHandoff
        ? failureMode === 'incomplete-package'
          ? '{}'
          : '这一次只回了一句话，没有按交接包要求的 JSON 形状输出。'
        : 'F7R_FILL ' + '这段文本只是把上下文写长，让真实的策略压缩能够触发。'.repeat(160)
      const completionTokens = Math.max(1, Math.ceil(text.length / 2))
      const usage = {
        prompt_tokens: state.promptTokensLast,
        completion_tokens: completionTokens,
        total_tokens: state.promptTokensLast + completionTokens
      }
      const id = timingFixture
        ? 'turn-timing-isolation-fixture'
        : successReceiptFixture
          ? 'handoff-start-receipt-fixture'
          : 'handoff-failure-fixture'
      if (failureMode === 'turn-timing') {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, timingTag === 'B' ? 10000 : 4000))
      }
      if (failureMode === 'turn-timing-kill' && state.turnRequests > 1) {
        state.followupHeld = true
        state.responses.add(res)
        res.once('close', () => {
          state.responses.delete(res)
          state.activeRequests = Math.max(0, state.activeRequests - 1)
        })
        return
      }
      if (shouldSendReportTool) {
        state.reportToolSent = true
        state.bashToolOffered = true
        state.toolCallSent = true
        const toolCall = {
          id: 'call_handoff_start_receipt_goal_report',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: reportCommand }) }
        }
        if (!wantsStream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: responseModel,
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
            usage
          }))
        } else {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
          state.responses.add(res)
          const writeChunk = (choice) => res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: 0,
            model: responseModel,
            choices: [choice]
          })}\n\n`)
          writeChunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null })
          writeChunk({ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null })
          writeChunk({ index: 0, delta: {}, finish_reason: 'tool_calls' })
          res.end('data: [DONE]\n\n')
          res.once('close', () => state.responses.delete(res))
        }
        state.activeRequests = Math.max(0, state.activeRequests - 1)
        return
      }
      if (failureMode === 'turn-timing-kill' && payload?.tools?.some((tool) => tool?.function?.name === 'bash')) {
        state.bashToolOffered = true
        state.toolCallSent = true
        const toolCall = {
          id: 'call_h6b_turn_timing_kill',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'echo H6B_TURN_TIMING_KILL_TOOL_RAN' }) }
        }
        if (!wantsStream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: 'turn-timing-isolation-fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
            usage
          }))
        } else {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
          state.responses.add(res)
          const writeChunk = (choice) => res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: 0,
            model: 'turn-timing-isolation-fixture',
            choices: [choice]
          })}\n\n`)
          writeChunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null })
          writeChunk({ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null })
          writeChunk({ index: 0, delta: {}, finish_reason: 'tool_calls' })
          res.end('data: [DONE]\n\n')
          res.once('close', () => state.responses.delete(res))
        }
        state.activeRequests = Math.max(0, state.activeRequests - 1)
        return
      }
      if (!wantsStream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: responseModel,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage
          })
        )
        if (!isHandoff) state.activeRequests--
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      state.responses.add(res)
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 0,
          model: responseModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 0,
          model: responseModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage
        })}\n\n`
      )
      res.end('data: [DONE]\n\n')
      if (!isHandoff) state.activeRequests--
      res.on('close', () => state.responses.delete(res))
    })
  })
  server.unref()
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('交接故障本机 provider 未分配 TCP 端口'))
        return
      }
      handoffFailureState = state
      resolvePromise({ server, port: address.port, state })
    })
  })
}

async function closeHandoffFailureProvider(provider) {
  if (!provider) return
  for (const response of provider.state.responses) response.destroy()
  await new Promise((resolvePromise) => provider.server.close(() => resolvePromise()))
}

async function assertPortAvailable(port) {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? reject(error) : resolvePromise()))
    })
  })
}

async function checkRemoteRoutes(_sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  say(String(probeText ?? '').includes('remote-routes.driver.ok=true'), 'Node 客户端对真实 Electron 远程路由的断言全绿')
  const state = remoteRouteProbeState
  lines.push(
    `本机 provider：总请求 ${state?.requests ?? 0}；测试消息请求 ${state?.targetRequests ?? 0}；目标流取消 ${state?.canceledTargetStreams ?? 0}`
  )
  say((state?.targetRequests ?? 0) === 1, '本机 provider 收到且只收到一次目标消息请求')
  say(
    (state?.canceledTargetStreams ?? 0) === 1 && (state?.completedTargetStreams ?? 0) === 0,
    '定向 abort 关闭了该目标消息对应的未完成 provider 流'
  )
  say((state?.invalidBodies ?? 0) === 0, '本机 provider 收到有效的 OpenAI 兼容请求体')
  return { ok, lines }
}

async function driveFilePreviewMutation({ caseCwd, delay }) {
  const file = join(caseCwd, 'README.md')
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay) + 5000))

  const original = readFileSync(file, 'utf8')
  const updated = `${original.trimEnd()}\nEXTERNAL_PROCESS_CHANGE_H4\n`
  writeFileSync(file, updated, 'utf8')
  const changedAt = new Date(Date.now() + 3000)
  utimesSync(file, changedAt, changedAt)

  return {
    ok: true,
    text: `✓ 独立 Node 测试进程改写 fixture README.md 并推进 mtime（${file}）`
  }
}

async function driveRemoteRoutes() {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '✓ ' : '✗ ') + text)
    if (!good) ok = false
  }
  const origin = `http://127.0.0.1:${REMOTE_ROUTE_API_PORT}/remote/v1`
  const token = REMOTE_ROUTE_TOKEN
  const request = async (path, { auth = true, method = 'GET', body, timeoutMs = 2500 } = {}) => {
    const headers = {}
    if (auth) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    let json = null
    try {
      json = await response.json()
    } catch {
    }
    return { status: response.status, json }
  }
  const untilStatus = async (predicate, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs
    let latest = null
    while (Date.now() < deadline) {
      try {
        latest = await request('/status')
      } catch (error) {
        latest = { status: 0, error }
      }
      if (latest.status === 200 && predicate(latest.json?.data)) return latest.json.data
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return latest?.json?.data ?? null
  }

  try {
    const healthDeadline = Date.now() + 20000
    let health = null
    while (Date.now() < healthDeadline) {
      try {
        health = await request('/health', { auth: false, timeoutMs: 800 })
        if (health.status === 200) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    say(health?.status === 200 && health.json?.ok === true, `真实 Electron 远程 health 路由返回 ${health?.status ?? '无响应'}`)

    const denied = await request('/status', { auth: false })
    say(denied.status === 401, `无 token 的受保护路由返回 401（实际 ${denied.status}）`)

    const before = await request('/status')
    const activeBefore = before.json?.data?.agent?.activeSessionId
    const targetSessionId = before.json?.data?.sessions?.find((session) => session.id === 'yan-remote-route-target')?.id
    say(before.status === 200 && typeof activeBefore === 'string', '带 token 的状态路由给出桌面当前会话 id')
    say(typeof targetSessionId === 'string' && targetSessionId !== activeBefore, '隔离沙箱中存在独立的后台目标会话')
    if (!targetSessionId) throw new Error('状态快照中找不到合成目标会话')

    const created = await request('/sessions/new', { method: 'POST', body: {} })
    const selectedSessionId = created.json?.data?.sessionId
    say(created.status === 200 && typeof selectedSessionId === 'string', '新建会话路由返回稳定 sessionId')
    if (!selectedSessionId) throw new Error('新建会话路由没有返回 sessionId')
    const active = await untilStatus((data) => data?.agent?.activeSessionId === selectedSessionId)
    say(active?.agent?.activeSessionId === selectedSessionId, '新建会话成为桌面当前视图')
    say(active?.sessions?.some((session) => session.id === targetSessionId), '原目标会话仍在会话列表中')

    const sendRequest = request(`/sessions/${encodeURIComponent(targetSessionId)}/messages`, {
      method: 'POST',
      body: { text: 'Reply briefly. This is an isolated local route test; do not use tools.' },
      timeoutMs: 60000
    }).catch((error) => ({ status: 0, error }))
    const running = await untilStatus((data) =>
      data?.agent?.runners?.some((runner) => runner.sessionId === targetSessionId && runner.running)
    )
    const targetRunner = running?.agent?.runners?.find(
      (runner) => runner.sessionId === targetSessionId && runner.running
    )
    const runId = targetRunner?.runId
    say(/^r[1-9]\d{0,8}$/.test(runId ?? ''), `目标 runner 运行中并公开精确 runId（${runId ?? '缺失'}）`)
    if (!runId) throw new Error('目标后台 runner 未进入运行态')
    say(targetRunner.isActive === false, '目标会话由后台 runner 执行，未切换桌面视图')
    say(running?.agent?.activeSessionId === selectedSessionId, '发送期间桌面当前会话未变化')

    await new Promise((resolve) => setTimeout(resolve, 500))
    const aborted = await request('/runs/abort', { method: 'POST', body: { runId } })
    say(aborted.status === 200 && aborted.json?.data?.runId === runId, `按精确 runId 中止成功（HTTP ${aborted.status}）`)

    const sent = await Promise.race([
      sendRequest,
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, error: 'timeout waiting for send route response' }), 8000))
    ])
    say(
      sent.status === 200 && sent.json?.data?.sessionId === targetSessionId && sent.json?.data?.runId === runId,
      `消息路由最终回报了匹配的 sessionId / runId（HTTP ${sent.status}）`
    )

    const settled = await untilStatus((data) =>
      data?.agent?.runners?.some((runner) => runner.runId === runId && !runner.running)
    )
    const finalTarget = settled?.agent?.runners?.find((runner) => runner.runId === runId)
    say(finalTarget?.sessionId === targetSessionId && finalTarget.running === false, '中止后精确目标 runner 已停止')
    say(settled?.agent?.activeSessionId === selectedSessionId, '中止目标任务后桌面当前会话未改变')
  } catch (error) {
    say(false, `远程路由驱动异常：${error instanceof Error ? error.message : String(error)}`)
  }

  lines.push(`remote-routes.driver.ok=${ok}`)
  return { ok, text: lines.join('\n') }
}

function startBoundaryServer() {
  const handleRequest = (req, res) => {
    const url = new URL(req.url ?? '/', BOUNDARY_ORIGIN)
    if (url.pathname === '/download') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="yan-probe-download.txt"'
      })
      res.end(`download fixture ${BOUNDARY_SECRET}\n`)
      return
    }
    if (url.pathname === '/whoami') {
      const cookie = /(?:^|;\s*)yan_probe_cookie=([^;]*)/.exec(req.headers.cookie ?? '')
      const value = cookie?.[1] ?? ''
      const hash = value ? createHash('sha256').update(value).digest('hex').slice(0, 8) : 'none'
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`cookie=${value ? 'present' : 'none'} hash=${hash}\n`)
      return
    }
    if (url.pathname === '/private') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('private-ok\n')
      return
    }
    if (url.pathname === '/popup') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>popup-opener</title><body>opener' +
          '<script>window.open("/private","_blank")</script></body>'
      )
      return
    }
    if (url.pathname === '/browser-fixture') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>browser-frame-fixture</title>' +
          '<body><h1>frame fixture</h1><output id="result">waiting</output>' +
          `<iframe title="same-origin frame" src="${BOUNDARY_ORIGIN}/browser-fixture-inner"></iframe>` +
          `<iframe title="cross-origin frame" src="http://localhost:${BOUNDARY_PORT}/browser-fixture-cross?private=fixture-secret"></iframe>` +
          '<script>addEventListener("message",e=>{if(e.data==="YAN_FRAME_SUBMITTED"){document.querySelector("#result").textContent="frame submitted";fetch("/browser-fixture-network?private=fixture-secret")}else if(String(e.data).startsWith("YAN_TYPED:")){document.querySelector("#result").textContent=String(e.data)}})</script></body>'
      )
      return
    }
    if (url.pathname === '/browser-fixture-inner') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><label>same choice<select aria-label="same-choice" name="same-choice"><option value="a">A</option><option value="b">B</option></select></label>')
      return
    }
    if (url.pathname === '/browser-fixture-cross') {
      process.stdout.write('[browser fixture] cross-origin iframe request received\n')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>cross-frame-form</title>' +
          '<label>cross input<input aria-label="cross-input" oninput="parent.postMessage(\'YAN_TYPED:\'+this.value, \'*\')"></label>' +
          '<label>cross choice<select aria-label="cross-choice" name="cross-choice"><option value="a">A</option><option value="b">B</option></select></label>' +
          '<button id="continue" onclick="parent.postMessage(\'YAN_FRAME_SUBMITTED\', \'*\')">Continue frame</button>'
      )
      return
    }
    if (url.pathname === '/browser-fixture-network') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('frame-network-ok')
      return
    }
    if (url.pathname === '/ask') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>ask</title><body>ask' +
          '<script>' +
          'try{navigator.geolocation.getCurrentPosition(function(){},function(){})}catch(e){}' +
          'try{if(window.Notification)Notification.requestPermission()}catch(e){}' +
          '</script></body>'
      )
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `yan_probe_cookie=${BOUNDARY_SECRET}; Path=/; SameSite=Lax`
    })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>yan boundary fixture</title>' +
        '<a id="dl" href="/download">download</a>'
    )
  }
  const servers = [createServer(handleRequest), createServer(handleRequest)]
  return new Promise((resolvePromise, rejectPromise) => {
    let ready = 0
    let settled = false
    const onListening = () => {
      ready++
      if (ready === servers.length && !settled) {
        settled = true
        resolvePromise({ close: () => servers.forEach((server) => server.close()) })
      }
    }
    for (const server of servers) server.once('error', (error) => {
      if (settled) return
      settled = true
      for (const active of servers) if (active.listening) active.close()
      rejectPromise(error)
    })
    servers[0].listen(BOUNDARY_PORT, '127.0.0.1', onListening)
    servers[1].listen(BOUNDARY_PORT, '::1', onListening)
  })
}

function checkBrowserBoundaryDownloads(sandboxRoot) {
  const lines = []
  if (!sandboxRoot) return { ok: false, lines: ['✗ 非隔离模式无法检查下载目录'] }
  const dir = join(sandboxRoot, 'downloads')
  const names = existsSync(dir) ? readdirSync(dir) : []
  lines.push(`  下载目录（隔离）：${names.length ? names.join(', ') : '（空）'}`)
  const file = names.find((n) => n === 'yan-probe-download.txt')
  let ok = Boolean(file)
  if (!file) {
    lines.push('  ✗ 没有找到 yan-probe-download.txt')
  } else {
    const size = statSync(join(dir, file)).size
    lines.push(`  ✓ yan-probe-download.txt 已落盘，${size} 字节`)
    ok = size > 0
    if (!ok) lines.push('  ✗ 文件是空的')
  }
  return { ok, lines }
}

let activeChild = null

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
    }
  }
  try {
    child.kill()
  } catch {
  }
}

function forceKillTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killTree(activeChild)
    process.exit(130)
  })
}

function findIntermediateTurnTiming(dir) {
  if (!dir || !existsSync(dir)) return null
  let latest = null
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (record?.final === false && Array.isArray(record.sourceIds) && record.sourceIds.length > 0) {
          if (!latest || Number(record.endedAt) > Number(latest.record.endedAt)) latest = { file, record }
        }
      } catch {
      }
    }
  }
  return latest
}

function runProbe(
  { probe, delay, keys, keysDelay, env: caseEnv, budget, visible, driver, hardKillAfterIntermediateTiming },
  env,
  driverContext
) {
  return new Promise((resolvePromise) => {
    let probeEnv = {
      ...env,
      ...(caseEnv ?? {}),
      YAN_PROBE: probe,
      YAN_PROBE_DELAY: String(delay),
      ...(process.env.YAN_SHOW_WINDOW || visible ? {} : { YAN_PROBE_HIDDEN: '1' }),
      ...(process.env.YAN_PROBE_SHOT
        ? {
            YAN_PROBE_SHOT: process.env.YAN_PROBE_SHOT,
            ...(process.env.YAN_PROBE_SHOT_DELAY ? { YAN_PROBE_SHOT_DELAY: process.env.YAN_PROBE_SHOT_DELAY } : {})
          }
        : {}),
      ...(keys ? { YAN_PROBE_KEYS: keys } : {}),
      ...(keys && keysDelay ? { YAN_PROBE_KEYS_DELAY: String(keysDelay) } : {})
    }
    if (SYNTHETIC_ONLY) probeEnv = syntheticEnvironment(probeEnv)
    for (const k of ['ELECTRON_RUN_AS_NODE', 'YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']) {
      delete probeEnv[k]
    }
    const showWindow = Boolean(process.env.YAN_SHOW_WINDOW || visible)
    const electronArgs = ['.']
    if (process.env.YAN_TEST_DPR) electronArgs.push(`--force-device-scale-factor=${process.env.YAN_TEST_DPR}`)
    if (showWindow) electronArgs.push('--disable-features=CalculateNativeWinOcclusion')
    const child = spawn(electronBin, electronArgs, {
      cwd: root,
      env: probeEnv,
      windowsHide: true,
      ...(hardKillAfterIntermediateTiming && process.platform !== 'win32' ? { detached: true } : {})
    })
    activeChild = child
    const driverPromise = driver
      ? Promise.resolve()
          .then(() => driver(driverContext))
          .catch((error) => ({ ok: false, text: `✗ 外部验收驱动异常：${error?.message ?? error}` }))
      : null

    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
    })
    child.stderr.on('data', (d) => {
      buf += d
    })

    const keyCost = keys ? (keysDelay ?? 0) + keys.split(',').length * 1500 : 0
    const killChild = () => killTree(child)
    const kill = setTimeout(killChild, delay + keyCost + (budget ?? 90_000))
    let intermediateSnapshot = null
    const snapshotPoll = hardKillAfterIntermediateTiming
      ? setInterval(() => {
          if (intermediateSnapshot || child.exitCode !== null || child.signalCode !== null) return
          const candidate = findIntermediateTurnTiming(join(env.YAN_DATA_DIR ?? '', 'turn-timing'))
          if (candidate && handoffFailureState?.failureMode === 'turn-timing-kill' && handoffFailureState.followupHeld) {
            intermediateSnapshot = candidate
            forceKillTree(child)
          }
        }, 50)
      : null

    child.on('exit', async (code) => {
      clearTimeout(kill)
      if (snapshotPoll) clearInterval(snapshotPoll)
      if (activeChild === child) activeChild = null
      const driven = driverPromise ? await driverPromise : null

      if (hardKillAfterIntermediateTiming && intermediateSnapshot) {
        const record = intermediateSnapshot.record
        let afterExitRecords = []
        try {
          afterExitRecords = readFileSync(join(env.YAN_DATA_DIR, 'turn-timing', intermediateSnapshot.file), 'utf8')
            .split('\n')
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line)]
              } catch {
                return []
              }
            })
        } catch {
        }
        resolvePromise({
          ok: true,
          hardKilled: true,
          text: [
            buf,
            `  turn-timing.hardkill.processExitedAfterForce=true (code=${String(code)}, signal=${String(child.signalCode)})`,
            `  turn-timing.hardkill.snapshot=${JSON.stringify({ file: intermediateSnapshot.file, record })}`,
            `  turn-timing.hardkill.afterExitRecords=${JSON.stringify(afterExitRecords)}`,
            driven?.text
          ].filter(Boolean).join('\n') + '\n'
        })
        return
      }
      if (hardKillAfterIntermediateTiming) {
        resolvePromise({
          ok: false,
          text: `${buf}\n  turn-timing.hardkill.processExitedAfterForce=false (未在真实 final:false 快照落盘后强杀)\n`,
          hint: 'Electron 在确认强杀条件前退出或达到预算；本场景不接受 seed 代替真强杀。'
        })
        return
      }

      const m = /---PROBE-START---\r?\n([\s\S]*?)\r?\n---PROBE-END---/.exec(buf)
      if (!m) {
        const hadOutput = buf.trim().length > 0
        resolvePromise({
          ok: false,
          text: [buf.slice(-3000), driven?.text].filter(Boolean).join('\n'),
          hint: hadOutput
            ? '没抓到 PROBE 输出（但有其它输出）—— 应用可能启动失败，先跑 `npm run probe-pi`。'
            : `一句输出都没有 —— 进程在探针打印前就被结束了。先看场景预算够不够：delay ${delay}ms + budget ${budget ?? 90_000}ms`
        })
        return
      }

      const body = m[1]
      const combined = [body, driven?.text].filter(Boolean).join('\n')
      const crashed = /探针出错|探针异常|probe threw/i.test(combined)
      const bad = /✗/.test(combined) || crashed
      resolvePromise({
        ok: !bad && code === 0 && (driven?.ok ?? true),
        text: combined + '\n',
        hint: bad
          ? crashed && !/✗/.test(combined)
            ? '探针在断言前就抛错了（不算通过）'
            : '输出里有 ✗ 的行'
          : undefined
      })
    })
  })
}


async function main() {

  const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  let names = argv.length ? argv : defaultLiveCases(CASES)
  const skippedDownloads = names.filter((n) => CASES[n]?.needsDownload && process.env.YAN_REAL_GIT_DOWNLOAD !== '1')
  if (skippedDownloads.length) {
    console.log(`跳过需要联网下载的场景：${skippedDownloads.join(', ')}（设置 YAN_REAL_GIT_DOWNLOAD=1 才会真的下载）`)
    names = names.filter((n) => !skippedDownloads.includes(n))
    if (!names.length) process.exit(0)
  }

  for (const n of names) {
    if (!CASES[n]) {
      console.error(`未知场景：${n}。可选：${Object.keys(CASES).join(' / ')}`)
      process.exit(2)
    }
  }

  for (const n of names) {
    try {
      readFileSync(join(root, CASES[n].probe), 'utf8')
    } catch {
      console.error(`场景 ${n} 的探针不存在：${CASES[n].probe} —— 场景表里的残留条目，请一并删除`)
      process.exit(2)
    }
  }

  console.log(`将运行：${names.join(', ')}`)
  console.log(`测试模型：${TEST_MODEL}（可用 YAN_TEST_MODEL 覆盖）`)
  const spends = names.filter((n) => CASES[n].cost > 0)
  if (spends.length) {
    for (const n of spends) {
      console.log(`⚠️  ${n} 会真的调用模型（花少量额度）→ ${modelForCase(CASES[n].model)}`)
    }
  }

  const ISOLATED = process.env.YAN_TEST_ISOLATED !== '0'
  if (SYNTHETIC_ONLY) validateSyntheticSelection(names, CASES, ISOLATED)
  const sandboxRoot = ISOLATED ? mkdtempSync(join(tmpdir(), 'yan-test-')) : null
  if ((names.includes('remoteroutes') || names.includes('turntimingkill')) && !sandboxRoot) {
    console.error('✗ remoteroutes / turntimingkill 必须运行在隔离 sandbox 中；拒绝触碰真实用户数据。')
    process.exit(2)
  }

  const fixtureBase = sandboxRoot ?? mkdtempSync(join(tmpdir(), 'yan-fixture-'))
  const fixtureProject = buildFixtureProject(fixtureBase)

  let boundaryServer = null
  if (names.some((n) => CASES[n].usesBoundaryServer)) {
    try {
      boundaryServer = await startBoundaryServer()
      console.log(`  本地 fixture 服务：${BOUNDARY_ORIGIN}（下载 / Cookie 哨兵 / 内网目标）`)
    } catch (error) {
      console.error(`✗ 端口 ${BOUNDARY_PORT} 起不了本地服务：${error?.message ?? error}`)
      console.error('  该端口被别的程序占着？先关掉它再跑（不自动换端口，否则探针会连到别人身上）')
      process.exit(2)
    }
  }
  if (names.includes('remoteroutes')) {
    try {
      await assertPortAvailable(REMOTE_ROUTE_API_PORT)
      console.log(`  远程 API 测试端口：${REMOTE_ROUTE_API_PORT}（仅 127.0.0.1）`)
    } catch (error) {
      console.error(`✗ 远程 API 测试端口 ${REMOTE_ROUTE_API_PORT} 不可用：${error?.message ?? error}`)
      console.error('  为避免探针误连到其它服务，本场景不自动换端口。')
      process.exit(2)
    }
  }
  let remoteRouteProvider = null
  let handoffFailureProvider = null

  if (sandboxRoot) {
    const cleanupSandbox = () => {
      try {
        allowDirRead(join(fixtureProject, 'noperm'))
        rmSync(sandboxRoot, { recursive: true, force: true })
      } catch {
      }
    }
    process.once('exit', cleanupSandbox)
    process.once('SIGINT', () => {
      cleanupSandbox()
      process.exit(130)
    })
    process.once('SIGTERM', () => {
      cleanupSandbox()
      process.exit(143)
    })
  } else {
    process.once('exit', () => {
      try {
        allowDirRead(join(fixtureProject, 'noperm'))
        rmSync(fixtureBase, { recursive: true, force: true })
      } catch {
      }
    })
  }

  let env = { ...process.env }
  if (sandboxRoot) {
    const userData = join(sandboxRoot, 'userData')
    const sessions = join(sandboxRoot, 'sessions')
    const data = join(sandboxRoot, 'data')
    const piDir = join(sandboxRoot, 'pi-agent')
    for (const d of [userData, sessions, data, piDir]) mkdirSync(d, { recursive: true })

    const sourceAgentDir = SYNTHETIC_ONLY ? join(sandboxRoot, 'synthetic-source') : process.env.YAN_PI_DIR?.trim() || join(homedir(), '.pi', 'agent')
    if (SYNTHETIC_ONLY) {
      mkdirSync(sourceAgentDir, { recursive: true })
      writeFileSync(join(sourceAgentDir, 'auth.json'), '{}', 'utf8')
      writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ packages: [], enableMcp: false }), 'utf8')
    }
    const copied = []
    const routeOnly = names.length === 1 && names[0] === 'remoteroutes'
    if (!routeOnly) {
      for (const f of ['auth.json', 'models.json', 'models-store.json']) {
        const src = join(sourceAgentDir, f)
        if (existsSync(src)) {
          copyFileSync(src, join(piDir, f))
          copied.push(f)
        }
      }
    }
    if (copied.length) {
      console.log(SYNTHETIC_ONLY ? '  pi 文件：仅使用临时空凭证，不读取个人模型目录' : `  pi 文件：已复制 ${copied.join(' / ')} 到隔离目录（仅本次测试，不进包）`)
    } else if (routeOnly) {      console.log('  pi 文件：远程路由场景使用独立本机 provider，不读取真实 auth.json / models.json')
    } else {
      console.log('  pi 文件：没找到凭证/模型目录 —— 依赖 pi 就绪的场景会失败')
    }

    const maxTokensCap = Number(
      names.map((n) => CASES[n].env?.YAN_TEST_MODEL_MAX_TOKENS).find((v) => v) ?? 0
    )
    if (Number.isFinite(maxTokensCap) && maxTokensCap > 0) {
      const modelsFile = join(piDir, 'models.json')
      try {
        const doc = JSON.parse(readFileSync(modelsFile, 'utf8'))
        let touched = 0
        for (const prov of Object.values(doc.providers ?? {})) {
          for (const model of prov?.models ?? []) {
            if (typeof model.maxTokens === 'number' && model.maxTokens > maxTokensCap) {
              model.maxTokens = maxTokensCap
              touched += 1
            }
          }
        }
        if (touched) {
          writeFileSync(modelsFile, JSON.stringify(doc, null, 2), 'utf8')
          console.log(`  测试前提修正：${touched} 个模型的 maxTokens 压到 ${maxTokensCap}（仅隔离副本）`)
        }
      } catch (err) {
        console.error(`  ⚠️  maxTokens 修正失败（继续跑原始前提）：${err?.message ?? err}`)
      }
    }

    writeFileSync(
      join(data, 'desktop.json'),
      JSON.stringify({ cwd: root, lang: 'zh-CN' }, null, 2),
      'utf8'
    )

    env = {
      ...env,
      YAN_USER_DATA: userData,
      YAN_SESSIONS_DIR: sessions,
      YAN_DATA_DIR: data,
      YAN_PI_DIR: piDir,
      YAN_TEST_SESSION_LIST_LIMIT: '500',
      YAN_DOWNLOADS_DIR: join(sandboxRoot, 'downloads')
    }
    mkdirSync(join(sandboxRoot, 'downloads'), { recursive: true })

    if (names.includes('remoteroutes')) {
      try {
        remoteRouteProvider = await startRemoteRouteProvider()
        const routePiDir = join(sandboxRoot ?? fixtureBase, 'pi-agent-remote-routes')
        mkdirSync(routePiDir, { recursive: true })
        writeFileSync(
          join(routePiDir, 'models.json'),
          JSON.stringify({
            providers: {
              yanrouteprobe: {
                name: 'Yan Remote Route Probe',
                baseUrl: `http://127.0.0.1:${remoteRouteProvider.port}/v1`,
                api: 'openai-completions',
                models: [{ id: 'route-probe', name: 'Route Probe', contextWindow: 32768, maxTokens: 256 }]
              }
            }
          }),
          'utf8'
        )
        writeFileSync(
          join(routePiDir, 'auth.json'),
          JSON.stringify({ yanrouteprobe: { type: 'api_key', key: 'local-route-fixture-only' } }),
          'utf8'
        )
        CASES.remoteroutes.model = 'yanrouteprobe/route-probe'
        CASES.remoteroutes.env = {
          YAN_PI_DIR: routePiDir,
          PI_OFFLINE: '1',
          YAN_REMOTE_ENABLE: '1',
          YAN_REMOTE_HOST: '127.0.0.1',
          YAN_REMOTE_PORT: String(REMOTE_ROUTE_API_PORT),
          YAN_REMOTE_TOKEN: REMOTE_ROUTE_TOKEN
        }
        console.log(`  远程路由本机 provider：127.0.0.1:${remoteRouteProvider.port}（无上游转发）`)
      } catch (error) {
        console.error(`✗ 无法启动远程路由本机 provider：${error?.message ?? error}`)
        process.exit(2)
      }
    }

    const localProviderNames = names.filter(
      (name) =>
        name === 'handoffrecover' ||
        name === 'handoffrecoverincomplete' ||
        name === 'handoffrecoverproviderfail' ||
        name === 'handoffcommitlocal' ||
        name === 'subagentlocal' ||
        name === 'turntimingisolation' ||
        name === 'turntimingkill'
    )
    if (localProviderNames.length > 1) {
      console.error('✗ 本机 provider fixture 场景请分开运行，避免共享请求统计混淆')
      process.exit(2)
    }
    if (localProviderNames.length === 1) {
      try {
        const fixtureName = localProviderNames[0]
        const isTurnTiming = fixtureName === 'turntimingisolation' || fixtureName === 'turntimingkill'
        const isHandoffCommitLocal = fixtureName === 'handoffcommitlocal'
        const isSubagentLocal = fixtureName === 'subagentlocal'
        const failureMode = isSubagentLocal
          ? 'subagent-normal'
          : isTurnTiming
          ? fixtureName === 'turntimingkill'
            ? 'turn-timing-kill'
            : 'turn-timing'
          : fixtureName === 'handoffrecoverincomplete'
            ? 'incomplete-package'
            : fixtureName === 'handoffrecoverproviderfail'
              ? 'provider-http-failure'
            : isHandoffCommitLocal
              ? 'handoff-start-receipt'
              : 'invalid-json'
        const providerId = isTurnTiming
          ? 'yantimingfixture'
          : isHandoffCommitLocal
            ? 'yanhandofffixture'
            : isSubagentLocal
              ? 'yansubagentfixture'
              : 'yanhandofffail'
        const modelId = isTurnTiming
          ? 'turn-timing-isolation-fixture'
          : isHandoffCommitLocal
            ? 'handoff-start-receipt-fixture'
            : isSubagentLocal
              ? 'subagent-local-fixture'
              : 'handoff-fail-fixture'
        handoffFailureProvider = await startHandoffFailureProvider(failureMode)
        mkdirSync(piDir, { recursive: true })
        const modelsFile = join(piDir, 'models.json')
        let models = {}
        try {
          models = JSON.parse(readFileSync(modelsFile, 'utf8'))
        } catch {
          models = {}
        }
        models.providers = {
          ...(models.providers ?? {}),
          [providerId]: {
            name: isTurnTiming
              ? 'Yan Turn Timing Fixture'
              : isHandoffCommitLocal
                ? 'Yan Handoff Receipt Fixture'
                : isSubagentLocal
                  ? 'Yan Subagent Local Fixture'
                  : 'Yan Handoff Failure Fixture',
            baseUrl: `http://127.0.0.1:${handoffFailureProvider.port}/v1`,
            api: 'openai-completions',
            models: [
              {
                id: modelId,
                name: isTurnTiming
                  ? 'Turn Timing Isolation Fixture'
                  : isHandoffCommitLocal
                    ? 'Handoff Start Receipt Fixture'
                    : isSubagentLocal
                      ? 'Subagent Local Fixture'
                      : 'Handoff Fail Fixture',
                contextWindow: 32768,
                maxTokens: 4096
              }
            ]
          }
        }
        writeFileSync(modelsFile, JSON.stringify(models, null, 2), 'utf8')
        const authFile = join(piDir, 'auth.json')
        let auth = {}
        try {
          auth = JSON.parse(readFileSync(authFile, 'utf8'))
        } catch {
          auth = {}
        }
        auth[providerId] = {
          type: 'api_key',
          key: isTurnTiming
            ? 'local-turn-timing-fixture'
            : isSubagentLocal
              ? 'local-subagent-fixture'
              : 'local-handoff-fixture-only'
        }
        writeFileSync(authFile, JSON.stringify(auth, null, 2), 'utf8')
        CASES[fixtureName].model = `${providerId}/${modelId}`
        CASES[fixtureName].env = {
          ...(CASES[fixtureName].env ?? {}),
          PI_OFFLINE: '1'
        }
        console.log(`  本机 provider fixture：127.0.0.1:${handoffFailureProvider.port}（${failureMode}，不发往外部）`)
      } catch (error) {
        console.error(`✗ 无法启动交接故障本机 provider：${error?.message ?? error}`)
        process.exit(2)
      }
    }

    if (boundaryServer) {
      process.once('exit', () => boundaryServer.close())
    }

    const seeded = seedSessions(sessions)
    if (names.includes('v3-shell') && sandboxRoot && process.env.YAN_V3_USAGE_FIXTURE !== '0') {
      const v3Usage = writeV3UsageFixture(sandboxRoot)
      CASES['v3-shell'].env = { ...(CASES['v3-shell'].env ?? {}), YAN_SESSIONS_DIR: v3Usage.usageSessions }
      console.log(
        `  v3-shell 用量夹具：主会话 ${v3Usage.mainTokens} token / ${v3Usage.mainMessages} 消息（15 天前）+ 子代理 ${v3Usage.subTokens} token（今天，仅隔离 sandbox）`
      )
    }
    if (names.includes('remoteroutes')) {
      const routeSession = writeRemoteRouteSession(sessions, fixtureProject)
      console.log(`  远程路由目标会话：${routeSession.id}（仅隔离 sandbox）`)
    }

    if (names.some((n) => CASES[n]?.abSessions)) {
      const made = writeAbSessions(sessions, join(fixtureProject, 'repo'), join(fixtureProject, 'other'))
      console.log(`  N12 A/B 会话：${made.map((m) => m.tag + '→' + m.cwd).join('，')}`)
    }

    if (names.some((n) => CASES[n]?.projectSessions || CASES[n]?.projectPeers)) {
      const made = writeProjectSwitchSessions(sessions, fixtureProject, join(fixtureProject, 'other'), {
        peers: names.some((n) => CASES[n]?.projectPeers),
        peerCwd: join(fixtureProject, 'repo'),
        opened: names.some((n) => CASES[n]?.openedSessions)
      })
      console.log(`  N05 项目会话：${made.map((m) => m.tag.toUpperCase() + '→' + m.cwd).join('，')}`)
    }

    const piDirNoAuth = join(sandboxRoot, 'pi-agent-no-auth')
    mkdirSync(piDirNoAuth, { recursive: true })
    const modelsForNoAuth = join(sourceAgentDir, 'models.json')
    if (existsSync(modelsForNoAuth)) copyFileSync(modelsForNoAuth, join(piDirNoAuth, 'models.json'))
    CASES.auth.env = { YAN_PI_DIR: piDirNoAuth }
    CASES.newuser.env = { YAN_PI_DIR: piDirNoAuth }
    const pathWithoutGit = (process.env.PATH ?? '')
      .split(';')
      .filter((dir) => dir && !existsSync(join(dir, 'git.exe')) && !existsSync(join(dir, 'bash.exe')))
      .join(';')
    CASES.gitinstall.env = {
      YAN_PI_DIR: piDirNoAuth,
      PATH: pathWithoutGit,
      ProgramFiles: join(sandboxRoot, 'no-program-files'),
      PROGRAMFILES: join(sandboxRoot, 'no-program-files'),
      ProgramW6432: join(sandboxRoot, 'no-program-files'),
      'ProgramFiles(x86)': join(sandboxRoot, 'no-program-files-x86'),
      'PROGRAMFILES(X86)': join(sandboxRoot, 'no-program-files-x86')
    }
    CASES.nogit.env = {
      YAN_PI_DIR: piDirNoAuth,
      PATH: pathWithoutGit,
      ProgramFiles: join(sandboxRoot, 'no-program-files'),
      PROGRAMFILES: join(sandboxRoot, 'no-program-files'),
      ProgramW6432: join(sandboxRoot, 'no-program-files'),
      'ProgramFiles(x86)': join(sandboxRoot, 'no-program-files-x86'),
      'PROGRAMFILES(X86)': join(sandboxRoot, 'no-program-files-x86')
    }


    const piDirSkill = join(sandboxRoot, 'pi-agent-skill')
    for (const d of [piDirSkill, join(piDirSkill, 'skills', 'probe-skill')]) mkdirSync(d, { recursive: true })
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) copyFileSync(src, join(piDirSkill, f))
    }
    writeFileSync(
      join(piDirSkill, 'skills', 'probe-skill', 'SKILL.md'),
      [
        '---',
        'name: probe-skill',
        'description: 仅用于验证「运行时技能会被报告进命令列表」的探测技能，没有任何实际能力。',
        '---',
        '',
        '这个技能存在的唯一目的：证明 pi 会把 `<agentDir>/skills` 下的 SKILL.md 变成命令列表里的 skill 来源条目。'
      ].join('\n'),
      'utf8'
    )
    CASES.slashcmd.env = {
      YAN_PI_DIR: piDirSkill,
      YAN_PROBE_SKILL: join(piDirSkill, 'skills', 'probe-skill', 'SKILL.md')
    }

    const piDirCustomApi = join(sandboxRoot, 'pi-agent-custom-api')
    mkdirSync(piDirCustomApi, { recursive: true })
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) copyFileSync(src, join(piDirCustomApi, f))
    }
    let customApiKey = ''
    try {
      const auth = JSON.parse(readFileSync(join(sourceAgentDir, 'auth.json'), 'utf8'))
      customApiKey = auth?.deepseek?.key ?? ''
    } catch {
      customApiKey = ''
    }
    if (customApiKey) {
      const modelsPath = join(piDirCustomApi, 'models.json')
      let models = { providers: {} }
      try {
        models = JSON.parse(readFileSync(modelsPath, 'utf8'))
      } catch {
        models = { providers: {} }
      }
      models.providers = models.providers ?? {}
      models.providers['yan-dp'] = {
        api: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
        apiKey: customApiKey,
        models: [
          {
            id: 'deepseek-chat',
            name: 'DeepSeek Chat（自定义接入）',
            contextWindow: 65536,
            maxTokens: 8192
          }
        ]
      }
      writeFileSync(modelsPath, JSON.stringify(models, null, 2), 'utf8')
    }
    CASES.customapie2e.env = { YAN_PI_DIR: piDirCustomApi }

    const piDirCapability = join(sandboxRoot, 'pi-agent-capability')
    for (const d of [piDirCapability, join(piDirCapability, 'skills', 'yan-capability-probe')])
      mkdirSync(d, { recursive: true })
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) copyFileSync(src, join(piDirCapability, f))
    }
    writeFileSync(
      join(piDirCapability, 'skills', 'yan-capability-probe', 'SKILL.md'),
      [
        '---',
        'name: yan-capability-probe',
        'description: 能力探测回执技能。用户要求「验证能力发现 / 按技能产出回执」时使用，会生成一份回执文件。',
        '---',
        '',
        '# 能力探测回执技能',
        '',
        '照下面步骤做，不要跳步：',
        '',
        '1. 在系统的临时目录里创建文件 `yan-capability-probe.txt`（`/tmp` 或 `$TEMP` 都可以），内容**恰好**是这一行：',
        '   `YAN-CAPABILITY-PROBE-OK 7f3a91`',
        '2. 用 bash 把该文件读回来，确认内容一致。',
        '3. 在最终回复里原样包含这一行标记。',
        '',
        '这行标记只出现在本技能正文里；没读到本技能就写不出它。'
      ].join('\n'),
      'utf8'
    )
    CASES.capsearch.env = {
      YAN_PI_DIR: piDirCapability,
      YAN_PROBE_SKILL: join(piDirCapability, 'skills', 'yan-capability-probe', 'SKILL.md')
    }
    CASES.capcli.env = {
      YAN_PI_DIR: piDirCapability,
      YAN_PROBE_SKILL: join(piDirCapability, 'skills', 'yan-capability-probe', 'SKILL.md')
    }

    const mcpServersFile = join(sandboxRoot, 'mcp-servers.json')
    writeFileSync(
      mcpServersFile,
      JSON.stringify(
        {
          servers: [
            {
              id: 'fixture',
              title: 'MCP 单测夹具服务',
              transport: 'stdio',
              command: process.execPath,
              args: [join(process.cwd(), 'scripts', 'lib', 'mcp-stdio-fixture.mjs')]
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    )
    CASES.mcpcli.env = { YAN_MCP_SERVERS_FILE: mcpServersFile }
    CASES.capsettings.env = { YAN_MCP_SERVERS_FILE: mcpServersFile }
    CASES.sourcecap.env = { YAN_MCP_SERVERS_FILE: mcpServersFile }

    if (names.some((n) => CASES[n].usesMcpRegisterFixture)) {
      const MCP_REG_FIXTURE_PORT = 39341
      const MCP_REG_CATALOG_PORT = 39342
      const mcpRegCatalogOrigin = `http://127.0.0.1:${MCP_REG_CATALOG_PORT}`
      const mcpRegCatalog = createServer((req, res) => {
        const url = new URL(req.url ?? '/', mcpRegCatalogOrigin)
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (url.pathname.startsWith('/npm')) {
          res.end(JSON.stringify({ objects: [] }))
          return
        }
        res.end(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'yan/fixture-remote',
                  title: '砚远程登记夹具服务',
                  description: '仅用于验证「目录候选 → 授权 → 端点核验 → 登记 → 可用」闭环的远程 MCP 服务。',
                  version: '1.0.0',
                  remotes: [{ type: 'streamable-http', url: `http://127.0.0.1:${MCP_REG_FIXTURE_PORT}/mcp` }]
                }
              }
            ]
          })
        )
      })
      const mcpRegHttpFixture = spawn(process.execPath, [join(root, 'scripts', 'lib', 'mcp-http-fixture.mjs')], {
        env: { ...process.env, YAN_MCP_HTTP_PORT: String(MCP_REG_FIXTURE_PORT) },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      try {
        await new Promise((resolvePromise, rejectPromise) => {
          mcpRegCatalog.once('error', rejectPromise)
          mcpRegCatalog.listen(MCP_REG_CATALOG_PORT, '127.0.0.1', resolvePromise)
        })
        await new Promise((resolvePromise, rejectPromise) => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            rejectPromise(new Error('MCP HTTP fixture 10s 内没起来'))
          }, 10_000)
          mcpRegHttpFixture.stderr.on('data', (chunk) => {
            if (settled) return
            if (String(chunk).includes('listening')) {
              settled = true
              clearTimeout(timer)
              resolvePromise()
            }
          })
          mcpRegHttpFixture.once('exit', (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            rejectPromise(new Error(`MCP HTTP fixture 提前退出（code=${code}）`))
          })
        })
      } catch (error) {
        console.error(`✗ mcpregister 的本地 fixture 起不了：${error?.message ?? error}`)
        process.exit(2)
      }
      console.log(`  本地 fixture 服务：目录 ${mcpRegCatalogOrigin} + MCP HTTP 127.0.0.1:${MCP_REG_FIXTURE_PORT}/mcp`)
      CASES.mcpregister.env = {
        YAN_MCP_REGISTRY_URL: `${mcpRegCatalogOrigin}/v0/servers`,
        YAN_NPM_SEARCH_URL: `${mcpRegCatalogOrigin}/npm`,
        YAN_MCP_SERVERS_FILE: join(sandboxRoot, 'mcp-servers-register.json'),
        YAN_PROBE_AUTO_AUTHORIZE_LOOPBACK_MCP: '1'
      }
      process.on('exit', () => {
        try {
          mcpRegCatalog.close()
        } catch {
        }
        try {
          mcpRegHttpFixture.kill()
        } catch {
        }
      })
    }

    CASES.capmcp.env = {
      YAN_MCP_SERVERS_FILE: mcpServersFile,
      YAN_MCP_FIXTURE_MARKER: join(sandboxRoot, 'mcp-probe-marker.txt')
    }

    const piDirTaskExt = join(sandboxRoot, 'pi-agent-task-ext')
    for (const d of [piDirTaskExt, join(piDirTaskExt, 'extensions')]) mkdirSync(d, { recursive: true })
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) copyFileSync(src, join(piDirTaskExt, f))
    }
    copyFileSync(
      join(root, 'scripts', 'fixtures', 'task-ext', 'left-info-panel.ts'),
      join(piDirTaskExt, 'extensions', 'left-info-panel.ts')
    )
    copyFileSync(
      join(root, 'scripts', 'fixtures', 'task-ext', 'notes-panel.ts'),
      join(piDirTaskExt, 'extensions', 'notes-panel.ts')
    )
    CASES.taskext.env = { YAN_PI_DIR: piDirTaskExt }

    console.log(`隔离目录：${sandboxRoot}`)
    console.log(`  fixture：${seeded} 份（${SYNTHETIC_ONLY ? '仅合成，无个人凭证/会话' : '真实会话只读拷贝 + 合成；原件不受影响'}）`)
    console.log('  （不碰真实的会话、派生状态与 localStorage）')
    console.log('  （也不碰真实的 ~/.pi/agent/auth.json —— 里面是用户的密钥）')
  } else {
    console.log('⚠️  YAN_TEST_ISOLATED=0 —— 直接改真实数据，仅用于排查问题')
  }

  let failed = 0

  const SCENARIO_SEED = '.seed'
  const SCENARIO_SEED_SKIP = new Set([SCENARIO_SEED, 'fixture-project'])
  const scenarioSeedRoot = sandboxRoot ? join(sandboxRoot, SCENARIO_SEED) : null
  if (sandboxRoot) {
    mkdirSync(scenarioSeedRoot, { recursive: true })
    for (const entry of readdirSync(sandboxRoot)) {
      if (SCENARIO_SEED_SKIP.has(entry)) continue
      cpSync(join(sandboxRoot, entry), join(scenarioSeedRoot, entry), { recursive: true })
    }
  }
  const restoreScenarioState = () => {
    if (!scenarioSeedRoot) return
    for (const entry of readdirSync(sandboxRoot)) {
      if (SCENARIO_SEED_SKIP.has(entry)) continue
      rmSync(join(sandboxRoot, entry), { recursive: true, force: true })
    }
    for (const entry of readdirSync(scenarioSeedRoot)) {
      cpSync(join(scenarioSeedRoot, entry), join(sandboxRoot, entry), { recursive: true })
    }
  }

  for (const name of names) {
    const c = { ...CASES[name] }
    console.log(`\n${'='.repeat(64)}\n▶ ${name}  (${c.probe})\n${'='.repeat(64)}`)
    restoreScenarioState()

    const wins = c.wins ?? [null]
    let allOk = true
    let hint
    let lastProbeText = ''
    const caseCwd = c.fixture ? (c.fixtureSub ? join(fixtureProject, c.fixtureSub) : fixtureProject) : root

    const piSettingsFile = sandboxRoot ? join(sandboxRoot, 'pi-agent', 'settings.json') : null
    if (piSettingsFile) {
      rmSync(piSettingsFile, { force: true })
      const settings = { defaultThinkingLevel: 'off', ...(c.piSettings ?? {}) }
      writeFileSync(piSettingsFile, JSON.stringify(settings, null, 2), 'utf8')
    } else if (c.piSettings) {
      console.log('  ⤺ 跳过：非隔离模式（YAN_TEST_ISOLATED=0）不会写真实 pi 目录的 settings.json')
      continue
    }
    const tempBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('yan-subagent-')))

    if (c.questionExtLog) rmSync(join(tmpdir(), 'yan-question-ext.log'), { force: true })
    if (c.goalResumeExtLog) rmSync(join(tmpdir(), 'yan-goal-resume.log'), { force: true })

    taskFixtureBaseline = null
    if (c.readonlySession && sandboxRoot) {
      taskFixtureBaseline = captureSessionFile(join(sandboxRoot, 'sessions'), c.readonlySession)
      console.log(
        taskFixtureBaseline
          ? `  只读基线：${basename(taskFixtureBaseline.path)}（${Buffer.byteLength(taskFixtureBaseline.text)} 字节）`
          : `  ⚠️  找不到只读基线会话：${c.readonlySession}`
      )
    }

    if (c.probePrefix) {
      if (!sandboxRoot) throw new Error('Prefixed probes require an isolated data directory')
      const wrapped = join(sandboxRoot, `probe-${name}.js`)
      writeFileSync(wrapped, c.probePrefix + readFileSync(join(root, c.probe), 'utf8'))
      c.probe = relative(root, wrapped)
    }
    const syntaxErr = checkProbeSyntax(c.probe)
    if (syntaxErr) {
      console.log(`  ✗ 探针脚本语法错误：${syntaxErr}`)
      failed++
      console.log(`\n✗ ${name} 未通过`)
      continue
    }
    let isolationSeeded = false
    let goalSeeded = false
    let goalReviewSeeded = false
    let contextGuardFixturePath = null

    for (const win of wins) {
      if (sandboxRoot) {
        const desktop = c.freshDesktop ? { lang: 'zh-CN' } : { cwd: caseCwd, lang: 'zh-CN' }
        if (process.env.YAN_TEST_DESKTOP_THEME === 'light' || process.env.YAN_TEST_DESKTOP_THEME === 'dark') {
          desktop.theme = process.env.YAN_TEST_DESKTOP_THEME
        }
        if (c.legacyAutonomous) desktop.autonomous = true
        if (c.knowledgeSeed) {
          desktop.projects = [
            {
              id: KNOWLEDGE_FIXTURE_PROJECT_ID,
              cwd: caseCwd,
              name: 'Fixture',
              archived: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
          ]
          desktop.projectKnowledge = { enabled: true }
        }
        if (!c.knowledgeIsolationSeed) {
          writeFileSync(join(sandboxRoot, 'data', 'desktop.json'), JSON.stringify(desktop, null, 2), 'utf8')
        }
        if (c.knowledgeSeed) {
          let fixtureSessionId
          try {
            const file = readdirSync(join(sandboxRoot, 'sessions'), { recursive: true })
              .map((name) => String(name))
              .find((name) => name.endsWith('.jsonl'))
            if (file) fixtureSessionId = basename(file).replace(/\.jsonl$/, '').split('_').slice(1).join('_')
          } catch {
          }
          await seedProjectKnowledge(join(sandboxRoot, 'data'), {
            withCandidate: c.knowledgeSeed === 'candidate',
            sessionId: c.knowledgeSeed === 'candidate' ? fixtureSessionId : undefined
          })
        }
        if (c.knowledgeIsolationSeed && !isolationSeeded) {
          await seedKnowledgeIsolation(sandboxRoot, fixtureProject, caseCwd)
          isolationSeeded = true
        }
        if (c.contextGuardSeed && !contextGuardFixturePath) {
          contextGuardFixturePath = writeContextGuardSession(join(sandboxRoot, 'sessions'))
          console.log(`  上下文守卫 fixture：${basename(contextGuardFixturePath)}（仅本场景）`)
        }
        if (c.goalSeed && !goalSeeded) {
          const count = await seedGoalDocument(join(sandboxRoot, 'data'), join(sandboxRoot, 'sessions'))
          console.log(`  目标链接 fixture：${count} 个会话各一份`)
          goalSeeded = count > 0
        }
        if (c.goalReviewSeed && !goalReviewSeeded) {
          const count = await seedPendingGoalReview(join(sandboxRoot, 'data'), join(sandboxRoot, 'sessions'))
          console.log(`  G-4 待审 fixture：${count} 个会话各一份（仅隔离数据）`)
          goalReviewSeeded = count > 0
        }
      }
      if (win) console.log(`\n─── 窗口 ${win} ───`)
      let brokenPiBin
      if (c.brokenPi && sandboxRoot) {
        brokenPiBin = join(sandboxRoot, 'broken-pi.js')
        writeFileSync(brokenPiBin, 'process.exit(3)\n', 'utf8')
      }
      const out = await runProbe(c, {
        ...env,
        ...(win ? { YAN_WIN: win } : {}),
        ...(c.contextExtLog && sandboxRoot ? { YAN_CONTEXT_EXT_LOG: join(sandboxRoot, 'ctx-ext.log') } : {}),
        ...(c.knowledgeExtLog && sandboxRoot ? { YAN_KNOWLEDGE_EXT_LOG: join(sandboxRoot, 'knowledge-ext.log') } : {}),
        ...(c.questionExtLog ? { YAN_QUESTION_EXT_LOG: join(tmpdir(), 'yan-question-ext.log') } : {}),
        ...(c.goalResumeExtLog ? { YAN_GOAL_RESUME_EXT_LOG: join(tmpdir(), 'yan-goal-resume.log') } : {}),
        ...(c.env ?? {}),
        ...(brokenPiBin ? { YAN_PI_BIN: brokenPiBin } : {}),
        ...(c.handoffExtLog && sandboxRoot ? { YAN_HANDOFF_EXT_LOG: join(sandboxRoot, 'handoff-ext.log') } : {}),
        YAN_TEST_MODEL: modelForCase(c.model)
      }, { sandboxRoot, fixtureProject, caseCwd, delay: c.delay })
      if (contextGuardFixturePath) {
        rmSync(contextGuardFixturePath, { force: true })
        contextGuardFixturePath = null
      }
      if (name === 'remoteroutes' && remoteRouteProvider) {
        await closeRemoteRouteProvider(remoteRouteProvider)
        remoteRouteProvider = null
      }
      if (
        (name === 'handoffrecover' || name === 'handoffrecoverincomplete' || name === 'handoffrecoverproviderfail' || name === 'turntimingisolation' || name === 'turntimingkill') &&
        handoffFailureProvider
      ) {
        handoffFailureState = handoffFailureProvider.state
        await closeHandoffFailureProvider(handoffFailureProvider)
        handoffFailureProvider = null
      }
      process.stdout.write(out.text)
      lastProbeText = out.text
      if (!out.ok) {
        allOk = false
        hint = hint ?? out.hint
      }
      if (c.usesBoundaryServer) {
        if (out.text.includes(BOUNDARY_SECRET)) {
          allOk = false
          console.log('  ✗ 输出里出现了 Cookie 值（哨兵）—— 凭证不得进日志/状态/结果')
        } else {
          console.log('  ✓ 输出里没有 Cookie 值（哨兵未泄漏）')
        }
        if (c.boundaryCookieCheck) {
          const expectedHash = createHash('sha256').update(BOUNDARY_SECRET).digest('hex').slice(0, 8)
          if (out.text.includes(`cookieHash=${expectedHash}`)) {
            console.log(`  ✓ 目标浏览器拿到的 Cookie 值与源值一致（sha256 前 8 位 ${expectedHash}）`)
          } else {
            allOk = false
            console.log(`  ✗ 目标浏览器里的 Cookie 值对不上（期待 cookieHash=${expectedHash}）`)
          }
        }
      }
    }

    if (allOk && c.restart) {
      if (c.seedBeforeRestart) {
        const seed = SEED_BEFORE_RESTART[c.seedBeforeRestart]
        console.log(
          seed
            ? `  重启前 seed：${seed(sandboxRoot) ?? 'ok'}`
            : `  ✗ 未注册的 seedBeforeRestart：${c.seedBeforeRestart}`
        )
        if (!seed) {
          allOk = false
          hint = hint ?? `未注册的 seedBeforeRestart：${c.seedBeforeRestart}`
        }
      }
      console.log(`\n─── 重启（第二次启动，同一份 YAN_DATA_DIR）───`)
      const out2 = await runProbe(
        { ...c.restart },
        { ...env, YAN_TEST_MODEL: modelForCase(c.restart.model ?? c.model) }
      )
      process.stdout.write(out2.text)
      lastProbeText = lastProbeText + out2.text
      if (!out2.ok) {
        allOk = false
        hint = hint ?? out2.hint
      }
    }

    if (c.afterExit && (allOk || c.afterExitOnFailure)) {
      const check = AFTER_EXIT[c.afterExit]
      if (!check) {
        console.log(`  ✗ 未注册的 afterExit 检查：${c.afterExit}`)
        allOk = false
        hint = hint ?? `未注册的 afterExit 检查：${c.afterExit}`
      } else {
        const res = await check(sandboxRoot, tempBefore, lastProbeText)
        console.log('\n退出后检查（Electron 已关闭）')
        console.log(res.lines.join('\n'))
        if (!res.ok) {
          allOk = false
          hint = hint ?? '退出后检查未通过'
        }
      }
    }

    if (!allOk) {
      failed++
      console.log(`\n✗ ${name} 未通过`)
      if (hint) console.log(`  提示：${hint}`)
      continue
    }

    console.log(`\n✓ ${name} 通过`)
  }

  if (sandboxRoot) {
    try {
      rmSync(sandboxRoot, { recursive: true, force: true })
    } catch {
    }
  } else {
    try {
      rmSync(fixtureBase, { recursive: true, force: true })
    } catch {
    }
  }

  console.log(`\n${'='.repeat(64)}`)
  const orphanPi = orphanPiProcesses()
  if (orphanPi === null) {
    console.log('\n孤儿进程：跳过检查（拿不到进程表，不把“查不到”当成“没残留”）')
  } else if (orphanPi.length === 0) {
    console.log('\n孤儿进程：✓ 没有残留的 pi 进程（命令行含 --mode rpc 且父进程已退出）')
  } else {
    failed++
    console.log(`\n孤儿进程：✗ 发现 ${orphanPi.length} 个残留的 pi 进程`)
    for (const row of orphanPi.slice(0, 6)) console.log(`    · ${row}`)
  }

  console.log(failed === 0 ? `全部通过（${names.length} 个场景）` : `${failed}/${names.length} 个场景失败`)
  process.exit(failed === 0 ? 0 : 1)


}

await main()
