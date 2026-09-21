/**
 * 会话模块的单元测试（不启动 Electron、不碰 pi、不花 token）。
 *
 * 为什么单独做：listSessions 的解析逻辑是纯函数式的 ——
 * 名字来源、`~` 缩写、缓存、删除的路径防护都可以用合成文件确定性地验证。
 * 放在真实会话目录里跑会污染用户数据，所以用 YAN_SESSIONS_DIR 指向临时目录。
 *
 * 用法： npm run test:unit
 */
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'yan-sessions-'))
const dataDir = await mkdtemp(join(tmpdir(), 'yan-data-'))
process.env.YAN_SESSIONS_DIR = dir
process.env.YAN_DATA_DIR = dataDir

// 必须在设置 env 之后 import（模块顶层读了这个变量）
const { listSessions, deleteSession, readTitleSamples, restoreSession, SESSIONS_DIR } = await import('../out/main/sessions.js')

/*
 * 回合分组的纯逻辑用 esbuild 现场编译。
 *
 * 为什么不用 out/main/*.js：`src/shared/turns.ts` 是共享层的模块，
 * 主进程的构建不会把它输出到 out/main（那是摇树后的产物，只有主进程
 * 真正 import 到的东西）。为了一个纯函数去改主进程的 import 图不值得 ——
 * 直接用项目里已有的 esbuild（vite 的依赖）转一下，几十毫秒。
 */
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

/*
 * 回合计时口径（src/shared/turn-timing.ts）。
 *
 * 与 turns.ts 一样是共享层纯函数，主进程构建不会单独输出它；
 * 现场编译一份，避免测试依赖主进程的摇树结果（实施-11 H-1）。
 */
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

/*
 * 人读时长（src/shared/duration.ts）。
 *
 * 回合页脚 / 图片进度 / 子代理列表共用它；同样是共享层纯函数，现场编译一份，
 * 不依赖主进程构建图（实施-11 H-7）。
 */
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

/*
 * 界面缩放的纯计算（src/main/zoom-math.ts）。
 *
 * 为什么不直接从 out/main/zoom-math.js import：它现在已经进了主进程
 * 构建入口（electron.vite.config.ts 的 input），但只要哪天有人把它
 * 从入口列表里删掉（它只被 zoom.ts import，而 zoom.ts 会被摇进 index.js），
 * 这个测试就会静默地找不到文件。现场编译一份不依赖构建图。
 */
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

/*
 * 流式增量推送（src/main/agent.ts）。
 *
 * 为什么不直接 import out/main/index.js：整个主进程入口会把 Electron 拉进来
 * （node 下跑不了）。而 AgentController 本身只依赖 node 内置与本地模块，
 * 所以单独 bundle 一份 —— 它的 handleEvent 是纯逻辑，不需要窗口、不需要 pi。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/agent.ts'],
    outfile: 'out/test/agent.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    /*
     * MCP SDK 必须 external：它依赖 CJS 包（cross-spawn），内联进 ESM bundle
     * 会把 `require` 变成 `Dynamic require ... is not supported`（04-S3 实测踩到）。
     * 运行时不从项目 node_modules 解析，与主进程构建的 externalize 行为一致。
     */
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    logLevel: 'silent'
  })
)

/*
 * AI 文件产物与生图适配层。
 *
 * 这两个模块依赖 node fs / fetch，但不依赖 Electron；现场 bundle 让单测
 * 能在没有窗口、没有真实 API 请求的情况下钉住 manifest、SVG 清理、
 * provider 选择和受控目录边界。真实 Codex/API 调用另由本轮验收记录。
 */
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
const { runArtifactTests } = await import('./test-artifacts.mjs')
await runArtifactTests()
const { runTurnTests } = await import('./test-turns.mjs')
const { runTurnTimingTests } = await import('./test-turn-timing.mjs')
const { runDurationTests } = await import('./test-duration.mjs')
const { runZoomTests } = await import('./test-zoom.mjs')
const { runFileRefTests } = await import('./test-filerefs.mjs')
const { runLinkTests } = await import('./test-links.mjs')
const { runResponseDetailTests } = await import('./test-response-detail.mjs')
const { runSnapshotTests } = await import('./test-snapshots.mjs')

/* 写入类工具的前后快照（diff 算法）。纯 node fs，现场编译一份。 */
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

/*
 * 链接路由（src/shared/links.ts）：纯函数，无依赖，单独 bundle。
 */
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

/*
 * 文件引用（拖入的普通文件）的校验/授权/读取。
 * 这里不依赖 Electron，只是 node fs —— 单独 bundle 一份即可。
 */
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

/*
 * 本机 Chrome profile 同步的纯逻辑（选 profile / 拼路径 / 逐项容错）。
 * 现场编译，理由同 turns.ts：这段逻辑只被 browser.ts import，
 * 主进程构建会把它摇进 index.js，不单独产出到 out/main。
 */
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

/*
 * 对话宽度钳取（src/shared/ipc.ts）。
 * ipc.ts 是纯类型/常量模块（无 electron / DOM 依赖），可以现场编译。
 */
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
const { runStreamWidthTests } = await import('./test-stream-width.mjs')
const { runQuestionTests } = await import('./test-question.mjs')

/*
 * 历史任务快照归并（src/main/todo-snapshots.ts）。
 * 纯函数（不碰 electron），现场编译一份测它 —— 不被主进程构建图影响。
 */
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
const { runWorkModeTests } = await import('./test-work-mode.mjs')
const { runGoalTests } = await import('./test-goal.mjs')

/*
 * 任务计划的纯逻辑（实施-02 S2）：校验 / reducer / 幂等 / 历史解析。
 * 同一个模块也要给`yan` CLI 用，所以现场编译一份、不依赖构建图。
 */
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

/*
 * 宿主任务服务（实施-02 S3）：真文件、真串行、真 CAS。
 * 与上面的纯逻辑分开测 —— 这一层的失败模式全在磁盘边上
 * （只追加 / 落盘失败不报成功 / 跨会话隔离），只用返回值验不出来。
 */
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

/*
 * 项目知识的纯逻辑与存储层（实施-03 S2）：身份只认登记、CAS、原子 manifest、
 * 崩溃恢复、墓碑防复活、排他锁。两块都要现场编译：shared 的那份保持平台中立，
 * store 那份要真碰文件系统。
 */
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

/* 项目知识的检索纯逻辑（实施-03 S3）：无 IO，但入口单独编译，避免测试从源码 import。 */
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

/*
 * 能力目录与技能服务（实施-04 S2）：shared 侧纯逻辑保持平台中立，
 * main 侧要真读 SKILL.md，所以两份分开编译。
 */
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

/*
 * 联网发现（实施-04 S5）：契约用 node:crypto 算指纹，所以两份都走 node 平台。
 */
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

/*
 * 接入事务（实施-04 S6a）：契约是纯逻辑，服务要真读写受管目录。
 * 两份分开编译 —— 共享层带 node:crypto 的话渲染端就用不了它。
 */
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
const { runPiPackageSchedulerTests } = await import('./test-pi-package-scheduler.mjs')
const { runPiPackageSmokeTests } = await import('./test-pi-package-smoke.mjs')

/*
 * MCP（实施-04 S3）：契约是纯逻辑；连接与工具服务要真起子进程（走官方 SDK）。
 * SDK 保持 external —— 真跑时从项目 node_modules 解析，不塞进 bundle。
 */
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

/*
 * 远程 MCP 登记（实施-04 S6b-1）：契约是纯逻辑；登记服务要真写文件、
 * 默认 probe 还要真连 HTTP。SDK 保持 external（与连接管理器同一处置）。
 */
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
const mcpRegistrationService = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/registration-service.ts'],
    outfile: 'out/test/registration-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    logLevel: 'silent'
  }).then(() => import('../out/test/registration-service.mjs'))
)
const { runMcpRegistrationTests } = await import('./test-mcp-registration.mjs')

/* 本地 MCP npm 包（实施-04 S6b-2）：固定 staging → bin 解析 → 真 stdio tools/list 冒烟。 */
const mcpPackage = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/capabilities/mcp-package.ts'],
    outfile: 'out/test/mcp-package.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    logLevel: 'silent'
  }).then(() => import('../out/test/mcp-package.mjs'))
)
const { runMcpPackageTests } = await import('./test-mcp-package.mjs')

/* 项目知识的注入链（实施-03 S3）：宿主准备文件 + 薄层扩展读文件注入。 */
const projectKnowledge = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/project-knowledge.ts'],
    outfile: 'out/test/project-knowledge.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/project-knowledge.mjs'))
)
const projectKnowledgeExtension = await import('../resources/pi-extensions/project-knowledge.js')
const { runProjectKnowledgeInjectionTests } = await import('./test-project-knowledge.mjs')
/* 项目知识视图层（实施-03 S5）：需复核是派生态，导出只含当前状态 */
const projectKnowledgeView = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/project-knowledge-view.ts'],
    outfile: 'out/test/project-knowledge-view.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/project-knowledge-view.mjs'))
)
const { runProjectKnowledgeViewTests } = await import('./test-project-knowledge-view.mjs')

/*
 * 扩展来源诊断（src/main/extensions-inventory.ts）：真实临时目录。
 * 它要能说清「用户扩展 / 砚薄层」各自是谁（实施-02 S1 的诊断出口）。
 */
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

/* L03 子代理写入隔离 / 差异归档 / 干净主工作树合并。 */
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

/*
 * 子代理控制器的策略（src/main/subagents.ts，D1–D4）。
 * 注入假 RPC 与可控工作区，不 spawn 真 pi；只有退出清理那条用真 git。
 */
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

/*
 * 项目 id 派生与碰撞退路（src/main/project-id.ts，D14）。
 * 纯函数，不碰 settings 文件。
 */
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

/*
 * 切项目时「该项目最近访问的会话」的选法（src/renderer/src/state/project-session.ts，N05）。
 * 渲染端模块，但它不 import React/zustand —— 只 import 类型 —— 所以能单独编译来测。
 */
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

/*
 * 队列快照的消费/回收规则（src/main/queue-items.ts，D9）。
 * 纯函数：判断“哪一条排队项已经被 pi 收走”，不碰进程与 IO。
 */
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

/*
 * 运行实例注册表的策略（src/main/runners.ts，N12）。
 * 纯逻辑：用假 agent 验证「切会话不停任务」「忙碌实例不被顶掉」
 * 「到上限明确拒绝」这些策略，不需要起任何 pi 进程。
 */
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

/*
 * 后台会话运行时缓存（src/renderer/src/state/session-runtime.ts）。
 * 这是与 DOM 无关的归并器，单测直接覆盖事件身份、增量和 generation 闸门。
 */
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

/* 项目/会话产品归属索引（src/main/session-layout.ts）。 */
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

/* 退出时的运行实例元数据快照；不依赖 Electron，单独 bundle 验证落盘边界。 */
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

/* N18 命令注册表：来源分类、兼容项和同名命令策略。 */const commandRegistry = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/command-registry.ts'],
    outfile: 'out/test/command-registry.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/command-registry.mjs'))
)

/* `/subagent` 本地命令参数解析：前置/尾置只读开关必须走同一条安全路由。 */
const subagentCommand = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/subagent-command.ts'],
    outfile: 'out/test/subagent-command.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/subagent-command.mjs'))
)

/*
 * 工具卡来源判定（src/shared/tool-origin.ts，实施-02 S4）。
 * 纯函数，单独 bundle —— 它只回答「这条 bash 调用是不是 yan tasks apply」。
 */
const toolOrigin = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/tool-origin.ts'],
    outfile: 'out/test/tool-origin.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/tool-origin.mjs'))
)

/* N02 模型能力：不从模型名称猜测，区分已知 / 不支持 / 未知。 */
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

/* 构建信息：正式版本 / 构建版本的本地时间格式化。 */
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

/* L04 网络边界：私网/IPv6/DNS rebinding 目标的纯逻辑。 */
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

/*
 * R04 手动标题落盘：读写都在 title.ts，但它同时装着会起 pi 进程的生成逻辑。
 * 单独 bundle 一份，只取 setManualTitle / manualTitles 两个入口 —— 不起进程。
 */
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

/* L04 网络边界判定：把「拦不拦」从 webRequest 回调里抽成了纯函数，单独编译。 */
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

/* @ 文件引用补全：只编译纯函数，不把 React 组件拉进 Node 测试。 */
const atQuery = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/components/chat/at-query.ts'],
    outfile: 'out/test/at-query.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/at-query.mjs'))
)
const { runAtQueryTests } = await import('./test-at-query.mjs')

/*
 * N01 拖拽排序：顺序计算是纯函数（`src/shared/rail-order.ts`），
 * 与渲染组件分开编译 —— 真实指针行为交给 `test:live -- railreorder`。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/rail-order.ts'],
    outfile: 'out/test/rail-order.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
const { runRailOrderTests } = await import('./test-rail-order.mjs')

/* 文件树与全项目文件名搜索：主进程只读 fs 模块，单独 bundle 以覆盖真实边界。 */
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

/* `/` 命令补全：光标范围与参数保留。 */
const slashQuery = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/components/chat/slash-query.ts'],
    outfile: 'out/test/slash-query.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/slash-query.mjs'))
)
const { runSlashQueryTests } = await import('./test-slash-query.mjs')

/* 能力列表响应的过期判定（sessionId 从 pending 过渡到 uuid 不该被判过期）。 */const capabilityRequest = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
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

/*
 * N21-2 压缩可观测：事件归一化（src/main/compaction.ts）+ 文案映射
 *（src/renderer/src/state/compaction-view.ts）。两者都是纯函数。
 */
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

/* 主进程 stdio 护栏（EPIPE 事故的修复点）：纯逻辑，不依赖 Electron。 */
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

/* 安卓远程管理层：HTTP/SSE 路由与认证边界，不启动 Electron 或 pi。 */
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

/*
 * N21-3 上下文策略：预算公式 + 触发决策在 shared（主进程与界面共用），
 * env 入口在主进程，阶段文案在渲染端。三块都是纯函数。
 */
const contextPolicy = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/context-policy.ts'],
    outfile: 'out/test/context-policy.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/context-policy.mjs'))
)
const contextPolicyEnv = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/context-policy.ts'],
    outfile: 'out/test/context-policy-env.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/context-policy-env.mjs'))
)
const contextView = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/renderer/src/state/context-view.ts'],
    outfile: 'out/test/context-view.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/context-view.mjs'))
)

/*
 * Command Code 订阅额度的窗口解析（src/main/quota-commandcode.ts）。
 * 纯函数，但同一个响应里「已用」与「剩余」两种口径并存，极易搞反；
 * 用线上真实快照钉住「月度 = 总额度 − 剩余」这条换算。
 */
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

/* 额度颜色分级（src/shared/quota-tone.ts）：渲染组件与单测用同一个函数，阈值不会漂。 */
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

const PROJECT = join(dir, '--C--Users-Test--')
await mkdir(PROJECT, { recursive: true })

const line = (o) => JSON.stringify(o) + '\n'

/** 造一个会话文件 */
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

// 父子孙分支必须作为一棵树移动，并可完整撤销。
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

// 正常删除：先移入回收站，再允许本次运行内撤销
const undoToken = await deleteSession(pPath)
list = await listSessions()
ok(!list.some((s) => s.id === 'ccc'), '删除后列表里没有了')
await restoreSession(undoToken)
list = await listSessions()
ok(list.some((s) => s.id === 'ccc'), '撤销后会话恢复到原路径')

// 越界路径必须被拒
let rejected = false
try {
  await deleteSession(join(dir, '..', '..', 'evil.jsonl'))
} catch {
  rejected = true
}
ok(rejected, '拒绝删除会话目录之外的文件')

// 非 jsonl 必须被拒
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
// 模块常量已经定型，这里只能验证「已删除的目录」不会抛
const empty = await listSessions()
ok(Array.isArray(empty), '目录被删后仍返回数组', `${empty.length} 条`)


// pi 定位（来源分类）——纯文件探测，不启 pi
console.log('\n--- 11. pi 定位：来源分类 ---')
const { resolvePi, bundledAvailable, piInfo, resetPiVersionCache } = await import('../out/main/protocol.js')

const piTmp = await mkdtemp(join(tmpdir(), 'yan-pi-'))
const fakeCli = join(piTmp, 'fake-cli.js')
await writeFile(fakeCli, '// stub\n', 'utf8')

// 环境变量命中
process.env.YAN_PI_BIN = fakeCli
const envProbe = resolvePi()
ok(envProbe.source === 'env', 'YAN_PI_BIN 命中时来源 = env', `source=${envProbe.source}`)
ok(envProbe.args.includes(fakeCli), 'env 命中时参数指向该入口')

// 设置项 override 优先于环境变量
const ovProbe = resolvePi({ override: fakeCli })
ok(ovProbe.source === 'override', 'piBin 优先于 YAN_PI_BIN', `source=${ovProbe.source}`)
ok(ovProbe.home === undefined || typeof ovProbe.home === 'string', 'home 字段类型正确')

delete process.env.YAN_PI_BIN

// piInfo 透传来源（会跑一次 --version，stub 无输出 → 版本 undefined）
resetPiVersionCache()
const piInfoRes = await piInfo(fakeCli, { fresh: true })
ok(piInfoRes.source === 'override', 'piInfo 透传来源', `source=${piInfoRes.source}`)
ok(piInfoRes.bin === fakeCli, 'piInfo.bin 为指定入口')
ok(typeof piInfoRes.bundledAvailable === 'boolean', 'piInfo.bundledAvailable 是布尔')

await rm(piTmp, { recursive: true, force: true })


// 回合分组 / 段落拆分 / 缓存命中率（纯函数，不启动 Electron）
await runTurnTests(ok)
await runTurnTimingTests(ok)
await runDurationTests(ok)


// 界面缩放（纯函数：DPI 取整 / 夹取 / 梯子）
await runZoomTests(ok)


// 文件引用：路径校验 / 授权 / 文本读取截断（安全边界）
await runFileRefTests(ok)


// 链接路由：网页 / 文件 / 行号 / 危险协议（安全判断）
await runLinkTests(ok)


// 回复详细程度扩展：三档注入 / standard 不注入 / 脏值回落
await runResponseDetailTests(ok)


// 写入类工具的前后快照与行级差异（安全证据）
await runSnapshotTests(ok)


// 本机 Chrome profile 同步（合成目录，不碰真实 profile）
await runChromeProfileTests(ok)


// 对话宽度钳取（纯函数）
await runStreamWidthTests(ok)


// 内置提问扩展（不启动 pi：import 后喂假 pi API）
await runQuestionTests(ok)

/*
 * 工作模式（实施-05 S2）：契约纯逻辑 + 会话级存储。
 * 两份分开编译：shared 那份是跨进程契约（可给 CLI 用），main 那份碰真文件。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/work-mode.ts'],
    outfile: 'out/test/work-mode.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/work-mode-service.ts'],
    outfile: 'out/test/work-mode-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
await runWorkModeTests(ok)

/*
 * 目标与澄清就绪（实施-05 S3）：契约纯逻辑 + 会话级存储（幂等 / 先落盘）。
 * 与工作模式同样分两份编译：shared 那份是跨进程契约，main 那份碰真文件。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/goal.ts'],
    outfile: 'out/test/goal.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/goal-service.ts'],
    outfile: 'out/test/goal-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
await runGoalTests(ok)

/*
 * 会话链（实施-05 S5b）：后台多段、前端一条。
 * 键归一化要与 `work-mode-service` 交叉校验，所以两份都要编出来。
 */
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
await runSessionChainTests(ok, await import('../out/test/work-mode-service.mjs'))
/*
 * 链感知历史（实施-05 S5b-4）：按段从旧到新拼接、缺段如实计数、没有链就是单文件。
 * 真实 JSONL + 真目录 —— 拼接逻辑不能靠 mock 验。
 */
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

/*
 * 模型出错后的自动继续（实施-05 S5c）：分类 / 退避 / 上限 / 幂等 / 存储。
 * 与其它 store 同样分两份编译：shared 那份是判定，main 那份碰真文件。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/auto-continue.ts'],
    outfile: 'out/test/auto-continue.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/auto-continue-service.ts'],
    outfile: 'out/test/auto-continue-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runAutoContinueTests } = await import('./test-auto-continue.mjs')
await runAutoContinueTests(ok)

/*
 * 跨会话交接的计数与契约（实施-05 S5a）：与目标状态同样分两份编译 ——
 * shared 那份是契约与纯逻辑，main 那份碰真文件（幂等 / 重启不归零）。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/handoff.ts'],
    outfile: 'out/test/handoff.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/handoff-service.ts'],
    outfile: 'out/test/handoff-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runHandoffTests } = await import('./test-handoff.mjs')
await runHandoffTests(ok)
/*
 * 交接包生成（实施-05 S5b-2）：请求 / 结果契约、模型输出解析、真目录上的文件交换、
 * 以及「请求 → 结果 → 解析 → 清洗 → 落盘」的全链路（不调模型）。
 * 顺带把薄层的 `safeKey()` 拿来做交叉校验 —— 两侧文件名规则不一致是静默失效。
 */
const { runHandoffRequestTests } = await import('./test-handoff-request.mjs')
await runHandoffRequestTests(
  ok,
  await import('../out/test/handoff.mjs'),
  await import('../out/test/handoff-service.mjs'),
  await import('../resources/pi-extensions/goal-resume.js')
)
/* 交接事务（实施-05 S5b-3a）：阶段顺序 / 幂等 / 崩溃恢复 / 事务日志 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/handoff-transaction.ts'],
    outfile: 'out/test/handoff-transaction.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/handoff-transaction-service.ts'],
    outfile: 'out/test/handoff-transaction-service.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runHandoffTransactionTests } = await import('./test-handoff-transaction.mjs')
await runHandoffTransactionTests(
  ok,
  await import('../out/test/handoff-transaction.mjs'),
  await import('../out/test/handoff-transaction-service.mjs'),
  await import('../out/test/handoff.mjs')
)
/*
 * 交接续接消息与消费证据 + 执行器（实施-05 S5b-3b）：
 * 标记与正文、以及「先停源 → 建目的 → 写链 → 发 resume → 证据」的全顺序与失败路径。
 * 执行器只靠注入的假依赖，不碰真 agent / runners。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/handoff-resume.ts'],
    outfile: 'out/test/handoff-resume.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/handoff-runner.ts'],
    outfile: 'out/test/handoff-runner.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runHandoffResumeTests } = await import('./test-handoff-resume.mjs')
await runHandoffResumeTests(
  ok,
  await import('../out/test/handoff-resume.mjs'),
  await import('../out/test/handoff.mjs')
)
const { runHandoffRunnerTests } = await import('./test-handoff-runner.mjs')
await runHandoffRunnerTests(
  ok,
  await import('../out/test/handoff-runner.mjs'),
  await import('../out/test/handoff-transaction-service.mjs'),
  await import('../out/test/session-chain-service.mjs'),
  await import('../out/test/handoff.mjs')
)
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
await runMcpRegistrationTests(ok, { shared: mcpRegistrationShared, service: mcpRegistrationService })
await runMcpPackageTests(ok, mcpPackage)
runProjectKnowledgeSearchTests(ok, projectMemorySearch)
await runProjectKnowledgeInjectionTests(ok, {
  prepare: projectKnowledge,
  store: projectMemoryStore,
  memory: projectMemory,
  extension: projectKnowledgeExtension
})
await runProjectKnowledgeViewTests(ok, projectKnowledgeView)
await runExtensionInventoryTests(ok)

await runSubagentIsolationTests(ok, subagentIsolation)

/* 子代理控制器：并发槽位、上下文代次、只读白名单、退出清理（D1–D4）。 */
await runSubagentControllerTests(ok, SubagentController)

/* 项目 id 派生：同前缀目录不能共用一个 id（D14）。 */
runProjectIdTests(ok, projectId)

/* 切项目选哪条会话：选错就会新建会话、把用户草稿弄丢（N05）。 */
runProjectSessionTests(ok, projectSession)

/* 队列快照的消费与回收：被接收的插话不能一直挂着“排队中”（D9）。 */
runQueueItemsTests(ok, queueItems)

/*
 * shell / 第三方工具的目录级改动归属（L05）：
 * 同大小不同内容、touch 不算改动、并发不认领、大文件不编造行数。
 */
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

/*
 * 运行实例注册表（N12）：切换不停任务、忙碌实例不被牺牲、并发上限。
 */
{
  const { runRunnerTests } = await import('./test-runners.mjs')
  await runRunnerTests(ok, RunnerRegistry)
}

{
  const { runSessionRuntimeTests } = await import('./test-session-runtime.mjs')
  runSessionRuntimeTests(ok, reduceSessionRuntime, sessionRuntimeKey, updateSessionRuntime, migrateSessionRuntime)
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
  const { runSubagentCommandTests } = await import('./test-subagent-command.mjs')
  runSubagentCommandTests(ok, subagentCommand.parseSubagentCommand)
}

{
  const { runToolOriginTests } = await import('./test-tool-origin.mjs')
  runToolOriginTests(ok, toolOrigin)
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
  runNetworkBoundaryTests(ok, networkBoundary)
}

runAtQueryTests(ok, atQuery)
/* Command Code 额度口径（月度是「剩余」不是「已用」）+ 颜色分级边界 */
{
  const { runQuotaCommandCodeTests, runQuotaToneTests } = await import('./test-quota.mjs')
  runQuotaCommandCodeTests(ok, quotaCommandCode)
  runQuotaToneTests(ok, quotaTone)
}
runSlashQueryTests(ok, slashQuery)
await runRailOrderTests(ok)
runCapabilityRequestTests(ok, capabilityRequest)
await runFileListingTests(ok, fileListing)

// 模型接入：provider 名映射（假 pi 探针，不碰真实 auth.json）
const { runCredentialsTests } = await import('./test-credentials.mjs')
await runCredentialsTests(ok)

// 应用内登录 ChatGPT 订阅（electron/fetch 都换成桩，不联网不开浏览器）
const { runOAuthTests } = await import('./test-oauth.mjs')
await runOAuthTests(ok)

// 流式增量推送协议（textDelta / thinkingDelta / outputDelta）
const { runStreamDeltasTests } = await import('./test-stream-deltas.mjs')
await runStreamDeltasTests(ok)

/*
 * N11 标题样本次序：先 bundle 一份 shared/title-samples.ts 再断言。
 * 与上下文策略同样的理由 —— shared 层不进主进程构建图时，
 * out/ 里可能根本没有这个模块。
 */
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

// N21-2：压缩事件归一化 + 文案映射
const { runCompactionStatusTests } = await import('./test-compaction-status.mjs')
runCompactionStatusTests(ok, compactionEvents, compactionView)

// 主进程 stdio 护栏：EPIPE 只记录、非 EPIPE 只上报、绝不 rethrow
const { runStdioGuardTests } = await import('./test-stdio-guard.mjs')
runStdioGuardTests(ok, stdioGuard)

// 安卓远程管理层：HTTP/SSE 路由与认证边界
await runRemoteServerTests(ok, remoteServer)

// N21-3：工作集预算 / 触发决策 / 阶段文案
const { runContextPolicyTests } = await import('./test-context-policy.mjs')
runContextPolicyTests(ok, contextPolicy, contextPolicyEnv, contextView)

/*
 * 请求前预算诊断（实施-05 S4）：扩展侧 JS 公式与 shared 交叉校验 + 三档边界。
 * 直接 import 随包源码（与 context-safety / context-transform 同一做法）。
 */
const contextBudgetExtension = await import('../resources/pi-extensions/context-budget.js')
const { runContextBudgetTests } = await import('./test-context-budget.mjs')
runContextBudgetTests(ok, contextBudgetExtension, contextPolicy)

/*
 * 界面语言扩展（resources/pi-extensions/language.js）。
 *
 * 它是**待分发的源码**（随包进 resources/pi-extensions），不是要构建的 src ——
 * 所以直接 import 那个 .js 文件；但它是 ESM + 顶层 `import node:fs`，
 * 因此在包内可以直接被 Node 加载（不在 isolated 环境也不依赖 Electron）。
 */
const languageExtension = await import('../resources/pi-extensions/language.js')
const { runLanguageExtensionTests } = await import('./test-language-extension.mjs')
await runLanguageExtensionTests(ok, languageExtension)

/*
 * 切片安全规则（resources/pi-extensions/context-safety.js，N21-10）。
 *
 * 与语言扩展同理：它是**待分发的源码**，直接在包内 import。
 * 这几条规则（正在用的 diff 不得删 / 用户约束不得降级 / 不从 reasoning 中间切）
 * 是阶段 4 压缩的前置约束 —— 先在纯函数层钉死，等扩展接进来时直接调。
 */
const contextSafety = await import('../resources/pi-extensions/context-safety.js')
const { runContextSafetyTests } = await import('./test-context-safety.mjs')
runContextSafetyTests(ok, contextSafety)

/*
 * N21-4 / S1：State 与 Archive 基础设施。
 *
 * 三块都要**现场编译**：
 *   · `shared/context-state.ts` —— schema 与校验（纯逻辑，主进程/扩展共用）；
 *   · `main/context-watermark.ts` —— 从原始会话文件读条目身份与水位；
 *   · `main/context-state-store.ts` —— 原子写 / 安全丢弃 / 会话清理。
 * 前两块在 electron-vite 的构建图里**不是**独立入口（只被主进程入口
 * import 后摇进 index.js），所以不能靠 out/main 里的文件；store 虽然
 * 会作为额外入口构建，这里仍然自己编译一份，避免测试依赖构建产物。
 */
const contextStateSchema = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/context-state.ts'],
    outfile: 'out/test/context-state.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/context-state.mjs'))
)
const contextWatermark = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/context-watermark.ts'],
    outfile: 'out/test/context-watermark.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/context-watermark.mjs'))
)
const contextStateStore = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/context-state-store.ts'],
    outfile: 'out/test/context-state-store.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }).then(() => import('../out/test/context-state-store.mjs'))
)
const { runContextStateTests } = await import('./test-context-state.mjs')
await runContextStateTests(ok, {
  state: contextStateSchema,
  watermark: contextWatermark,
  store: contextStateStore
})

/*
 * N21-4 / S2–S6：上下文变换（Tool Sweep / Task State / Recall / 结构化压缩闸门）。
 *
 * 三个模块都是**待分发的扩展源码**（resources/pi-extensions），直接 import。
 * 最后一组断言把 JS 写出的归档文件喂给 S1 的 TS schema —— 跨语言交叉验证，
 * 而不是让两边各信各的。
 */
const contextTransform = await import('../resources/pi-extensions/context-transform.js')
const contextExtension = await import('../resources/pi-extensions/context.js')
const { runContextTransformTests } = await import('./test-context-transform.mjs')
await runContextTransformTests(ok, {
  transform: contextTransform,
  extension: contextExtension,
  schema: contextStateSchema
})

/*
 * N21-4 剩余项：状态生成器（语义部分 + 确定性 evidence + CAS）。
 *
 * 它是**唯一**会调模型、又会写用户派生数据的地方，所以判定全在纯逻辑层
 * （`context-producer.js`）；最后一组用 fake ctx 真跑一遍落盘，并把 JS 写出的
 * 状态文件喂给 TS schema 交叉校验（与 transform 测试同一约定）。
 */
const contextProducer = await import('../resources/pi-extensions/context-producer.js')
const { runContextProducerTests } = await import('./test-context-producer.mjs')
await runContextProducerTests(ok, {
  producer: contextProducer,
  transform: contextTransform,
  extension: contextExtension,
  schema: contextStateSchema
})

/*
 * N21-4 剩余项：阶段运行状态（三阶段独立 Rearm / Cooldown，方案 §12.3）。
 *
 * 它与上下文策略、状态生成器都不同：它管的是「到线之后能不能动手」。
 * 判定错的每一种方式都是静默的 —— 阶段永久失效、每轮重试、两个阶段互相牵连 ——
 * 所以边界（回购比例、冷却边界、重试窗口）全部钉在纯函数层。
 */
const stageRuntime = await import('../resources/pi-extensions/context-stage-runtime.js')
const { runContextStageRuntimeTests } = await import('./test-context-stage-runtime.mjs')
await runContextStageRuntimeTests(ok, { stage: stageRuntime })

/*
 * N21-8：Deep Context（Pass 1 工作集归纳）。
 *
 * 它是唯一会在用户提问前**同步阻塞**一次模型调用的部分，而失败是两头静默的：
 * 该跑时没跑（用户以为开了）与不该跑时跑了（每轮多一次调用 + 最多多等 30s）。
 * 所以闸门、输入有界、解析容错、注入幂等全部钉在纯逻辑层。
 */
const contextDeep = await import('../resources/pi-extensions/context-deep.js')
const { runContextDeepTests } = await import('./test-context-deep.mjs')
await runContextDeepTests(ok, { deep: contextDeep, extension: contextExtension })

/*
 * IPC 错误剥壳（src/shared/ipc-error.ts）：`piCall` 与渲染端直接 catch 的
 * 调用点共用同一套规则，它的输出就是用户看到的提示条文案。
 */
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

/*
 * 「兼容搜索能力」判定（src/shared/web-search.ts，实施-07 S4）：来源菜单里那枚
 * 搜索入口只在命中时出现 —— 判松了会出现假能力（内置的 knowledge.search 就是最近的一条），
 * 判紧了功能永远不可达。纯函数，不连任何服务。
 */
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

/*
 * 工作树 Fork 的路径重绑定（src/shared/fork-rebind.ts，实施-07 S2b-3）：把源会话的文件引用
 * 拿到**工作树的仓库根**下重新解析并验证存在性。纯函数（文件系统由调用方注入）——
 * 这里必须钉住的是「`outside` 与 `missing` 不能混」、「`..` 与仓库外绝对路径不迁」、
 * 「Windows 大小写/分隔符差异不能当成“文件没了”」这三件容易写错的事。
 */
const forkRebind = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/fork-rebind.ts'],
    outfile: 'out/test/fork-rebind.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/fork-rebind.mjs'))
)
const { runForkRebindTests } = await import('./test-fork-rebind.mjs')
await runForkRebindTests(ok, forkRebind)

/*
 * Fork 的语义注入正文（src/shared/fork-context.ts，实施-07 S2b-4）：新会话拿到的
 * 那段「接手必须知道的」。环境派生状态只能来自传入的 `env`，没有交接包时不许编造 ——
 * 这两条错了都不会报错，只会让新会话误解自己的处境。
 */
const forkContextMod = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/fork-context.ts'],
    outfile: 'out/test/fork-context.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/fork-context.mjs'))
)
const { runForkContextTests } = await import('./test-fork-context.mjs')
await runForkContextTests(ok, forkContextMod)

/*
 * N21-9 A/B 基准的口径（src/shared/context-bench.ts，实施-06 S2）：四组策略怎么用
 * 现有开关表达、一条回答算不算守住约束、主判据与三项副指标的边界。
 * 纯函数，不跑模型 —— 真实对照跑批要额度，见 `npm run bench:context`。
 */
const contextBench = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/context-bench.ts'],
    outfile: 'out/test/context-bench.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/context-bench.mjs'))
)
const { runContextBenchTests } = await import('./test-context-bench.mjs')
/* 任务集是数据（不随包分发），但它的约束必须能被判分规则正确区分 —— 所以拉进来自检 */
const contextBenchTasks = await import('./bench/context-tasks.mjs')
await runContextBenchTests(ok, contextBench, contextPolicy, contextBenchTasks)

/*
 * Git 审查的纯解析（src/shared/git.ts）：`git status/diff` 的 NUL 分隔输出、
 * rename 多占一段、二进制的 `-`、未跟踪文件的补全、unified diff 的行号。
 * 平台用 neutral —— 这个模块**不依赖 node 内置**（渲染端也要 import 它）。
 */
const gitReview = await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/git.ts'],
    outfile: 'out/test/git.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  }).then(() => import('../out/test/git.mjs'))
)
const { runGitReviewTests } = await import('./test-git-review.mjs')
await runGitReviewTests(ok, gitReview)

/*
 * Git **写操作**的纯逻辑（src/shared/git-actions.ts）：失败分类、输入校验、
 * 版本摘要、命令构造。真跑 git 的部分在 test-git-repo.mjs。
 */
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

/*
 * Git 审查的**真实仓库**验证：数据层与真 git 的接口（临时目录、不碰用户数据）。
 * 与上面的纯解析测试是两层：那边验“我写的解析对不对”，这边验
 * “git 真的是这样输出的吗”，以及最要紧的“只读查询不会改暂存区”。
 */
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
      entryPoints: ['src/main/hosting.ts'],
      outfile: 'out/test/hosting.mjs',
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
      entryPoints: ['src/main/packages.ts'],
      outfile: 'out/test/packages.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning'
    }),
    build({
      entryPoints: ['src/main/git-diff.ts'],
      outfile: 'out/test/git-diff.mjs',
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent'
    })
  ])
)
const { runGitRepoTests } = await import('./test-git-repo.mjs')
const { runPackagesTests } = await import('./test-packages.mjs')
const { runSourcesTests } = await import('./test-sources.mjs')
const { runWorktreeLinkTests } = await import('./test-worktree-links.mjs')
const { runHostingTests } = await import('./test-hosting.mjs')
console.log('\n--- P2. pi 包管理（真实 pi CLI，隔离 agent 目录）---')
await runPackagesTests(ok)
console.log('\n--- S1. 会话来源的持久化引用 ---')
await runSourcesTests(ok)
console.log('\n--- S2. 会话↔工作树来源关系（实施-07）---')
await runWorktreeLinkTests(ok)
console.log('\n--- G3. PR 状态（纯解析 + 一次真实 API）---')
await runHostingTests(ok)
await runGitRepoTests(ok)

/*
 * 宿主能力服务（docs/plan/实施-01-默认pi架构迁移.md 的 S2）：身份校验与结果管道。
 *
 * 为什么用真实 HTTP 而不是 mock：这一片的出口就是「管道能跑」——
 * 端点、token、身份比对、结果落文件，任何一环断了都算没做完；
 * mock 掉就正好把要验的东西绕过去了。
 */
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

  /* 项目知识（实施-03 S4）：登记面至少要认这三个动作 */
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

/*
 * `yan` 启动器（src/main/yan-cli.ts）。
 *
 * 这几条断言的都是「打包后会出事的点」：用错运行时（用户的 node）、
 * 指错脚本（开发态的路径带进包里）、或者找不到 CLI 时默默生成一个坏启动器。
 */
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

  /*
   * ⚠️ 真跑一次随包 CLI，而不是只读它的文本。
   *
   * S3 那一轮只断言了启动器**文件内容**包含 ELECTRON_RUN_AS_NODE=1、
   * 指向 yan.mjs —— 结果 help 文案里多了一对反引号（模板字符串里嵌
   * 反引号），整个 CLI 直接语法错误，直到 cost 1 的 taskcli 才暴露：
   * 模型看到的是 Node 的 ESM 报错堆栈，而单测全绿。
   * 一条 `node --check` + 一次 `--help` 就能把这类错挡在门槛里。
   */
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
  ok(capabilityHelp.status === 0 && /--retry/.test(capabilityHelp.stdout ?? '') && /受管 staging/.test(capabilityHelp.stdout ?? ''), 'yan CLI：能力接入帮助说明固定 SRI staging 与显式重试')

  await rm(binDir, { recursive: true, force: true })
}

/*
 * 实施-02 S5：**证据链的前提**也要有防线。
 *
 * 这一片的证据全建在几份「看着不重要」的文件上，它们被删/被改之后
 * **没有任何测试会报错**（只会静默地少报几条）：
 *   · `scripts/fixtures/task-ext/notes-panel.ts` —— 少了它，taskext 退化成
 *     「只有一个扩展」，而场景仍全绿；
 *   · `CASES.taskplan` —— 少了它，S5 的真实多步任务证据就没了；
 *   · `electron-builder.yml` 的 `resources/yan-cli` —— 少了它，装出来的应用里
 *     模型敲 `yan` 只会得到「不是内部或外部命令」，而开发态一切照旧。
 * 所以在这里钉住「它们还在、而且还是它们该有的样子」。
 */
{
  const { existsSync, readFileSync } = await import('node:fs')

  const notesFix = 'scripts/fixtures/task-ext/notes-panel.ts'
  const notesText = existsSync(notesFix) ? readFileSync(notesFix, 'utf8') : ''
  ok(existsSync('scripts/fixtures/task-ext/left-info-panel.ts'), 'S5 fixture：旧任务扩展还在')
  ok(notesText.length > 0, 'S5 fixture：无关扩展（notes-panel.ts）还在')
  ok(/registerCommand\('notes'/.test(notesText), 'S5 fixture：无关扩展真的注册了自己的 /notes 命令')
  /*
   * 用 “有没有写 custom entry” 当判据，而不是搜 `left-panel-tasks` 这个名字：
   * fixture 的**注释**里就会出现那个词（它正是在解释「不能碰它」），
   * 搜字符串会把这个 fixture 自己的说明文字当成违规。
   */
  ok(
    !/appendEntry/.test(notesText),
    'S5 fixture：无关扩展不写任何 custom entry（否则它就不是「无关」了）'
  )

  const live = readFileSync('scripts/test-live.mjs', 'utf8')
  ok(/probe: 'scripts\/probe\/taskplan\.js'/.test(live), 'S5 场景：taskplan 探针已接线')
  ok(/taskPlanMultiStep/.test(live), 'S5 场景：taskplan 有退出后核对（三处一致的磁盘那一半）')
  ok(existsSync('scripts/probe/taskplan.js'), 'S5 场景：taskplan 探针文件存在')

  const builder = readFileSync('electron-builder.yml', 'utf8')
  ok(/from: resources\/yan-cli/.test(builder), '打包：yan-cli 在 extraResources 里')
  ok(/to: yan-cli/.test(builder), '打包：yan-cli 落到安装目录的 yan-cli/')
}

/*
 * 能力入口说明扩展（01-S3）。
 *
 * 这里锁的是**内容约定**而不是措辞：说明里必须同时有「怎么查用法」
 * 与「结果是摘要 + 文件，别整份读进上下文」—— 后者决定了 CLI 路线
 * 到底省不省 token；只要有一句就够了，多的不要。
 */
{
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  await build({
    entryPoints: ['resources/pi-extensions/capability-guide.js'],
    outfile: 'out/test/capability-guide.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
  const mod = await import('../out/test/capability-guide.mjs')
  const guide = mod.CAPABILITY_GUIDE

  ok(/yan --help/.test(guide), '能力说明：告诉模型按需查完整用法')
  ok(
    /resultFile/.test(guide) && /不要把整个结果文件/.test(guide),
    '能力说明：写明「摘要 + 结果文件，别整份读进上下文」'
  )
  ok(
    /yan subagent start/.test(guide) && /yan subagent list/.test(guide) && /yan subagent stop/.test(guide),
    '能力说明：明确告诉模型可以启动、查看、停止子代理'
  )
  ok(/实时显示在输入区上方和右侧详情面板/.test(guide), '能力说明：告知模型用户能看到子代理工作进度')
  ok(/Skill/.test(guide) && /MCP/.test(guide), '能力说明：写明能力选择优先顺序')

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

/*
 * i18n 文案是**纯文本**：`t()` 的结果直接插进 JSX 文本节点
 * （如 Settings.tsx 的 `<div className="set-desc">{t('…')}</div>`），
 * 没有 markdown 渲染。所以文案里写 `**正在运行**` 就会把星号原样画到
 * 界面上 —— set.toolDetailDesc 就是这么错的（已在截图里看到）。
 *
 * 这里只拦最容易被误用的加粗记号；要真的支持 markdown 时，
 * 把这条改成“该键允许 markdown”的名单。
 */
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
}

/*
 * 实施-01 S4b：`yan browser` CLI + 薄层不再注册任何东西。
 *
 * 四条一起看才站得住（缺一条就是“命令已接通但会报错”那一类）：
 *   ① `browser.js` 调 default(pi) 时**什么都不注册** —— 这是「薄层不注册模型工具、
 *      不注册 pi 命令、不挂钩子」的永久守卫点（模型工具表没有 RPC 出口，
 *      只能在扩展侧钉）；
 *   ② `browser.*` 真的登在 `KNOWN_COMMANDS` 里（且 `browser.evaluate` **有意不在**）；
 *   ③ `yan browser --help` 真能跑（S3 那次 yan.mjs 语法错只被 cost 1 场景抳到）；
 *   ④ 拼错子命令 / 漏参数给可读 JSON + 用法退出码，不是 Node 堆栈。
 *
 * ②——④ 都能在无 Electron、无 session 的情况下验完：本地校验刻意放在身份检查之前。
 */
{
  const { spawnSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const { build } = await import('../node_modules/esbuild/lib/main.js')

  console.log('\n--- 01-S4b 浏览器 CLI ---')

  /* ① 扩展不再注册任何东西 */
  const browserExt = await import(new URL('../resources/pi-extensions/browser.js', import.meta.url))
  const registered = []
  browserExt.default({
    registerTool: (tool) => registered.push(`tool:${tool?.name}`),
    registerCommand: (name) => registered.push(`command:${name}`),
    on: (name) => registered.push(`on:${name}`)
  })
  ok(registered.length === 0, 'browser.js：不注册模型工具 / pi 命令 / 钩子', registered.join(', '))
  ok(typeof browserExt.default === 'function', 'browser.js：仍保留默认导出（pi 加载扩展要求）')

  /* ② browser.* 已登记（用真实端点验，而不是读源码字符串） */
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
  const evaluate = await call('browser.evaluate', { script: '1+1' })
  ok(
    evaluate.status === 400 && evaluate.body.error === 'unknown_command',
    '能力服务：browser.evaluate 有意不登记（不提供任意页面 JavaScript）'
  )
  server.stop()
  await rm(opsDir, { recursive: true, force: true })

  /* ③ —— ④ 真跑随包 CLI（spawn），并且清掉身份环境变量 */
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
    /navigate/.test(help.stdout ?? '') && /screenshot/.test(help.stdout ?? ''),
    'yan CLI：browser 用法里列了动作（模型能发现）'
  )
  const mainHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', '--help'], {
    encoding: 'utf8',
    env
  })
  ok(/yan browser/.test(mainHelp.stdout ?? ''), 'yan CLI：主用法里也有 browser 一行')

  const typo = runYan(['browser', 'frobnicate'])
  const typoBody = jsonOf(typo.stdout)
  ok(typo.status === 2, 'yan CLI：未知子命令走用法退出码 2')
  ok(/未知的 browser 子命令/.test(String(typoBody?.error ?? '')), 'yan CLI：未知子命令给中文提示')
  ok(!looksLikeStack(typo.stdout ?? ''), 'yan CLI：未知子命令不抛堆栈')

  const missingArg = runYan(['browser', 'navigate'])
  const missingBody = jsonOf(missingArg.stdout)
  ok(missingArg.status === 2, 'yan CLI：漏参数走用法退出码 2')
  ok(/--url/.test(String(missingBody?.error ?? '')), 'yan CLI：漏参数指出缺哪个 flag')
  ok(!looksLikeStack(missingArg.stdout ?? ''), 'yan CLI：漏参数不抛堆栈')

  /* 身份缺失要归到「宿主不可用」（退出码 3），不能和业务失败（1）混'  */
  const noHost = runYan(['browser', 'observe'])
  ok(noHost.status === 3, 'yan CLI：没有宿主环境变量时走「不可用」退出码 3')
  ok(/宿主能力服务不可用/.test(noHost.stdout ?? ''), 'yan CLI：说明是宿主不可用（不是命令不存在）')

  /* dry 一下：用法表里的动作名必须与 GROUP_SPECS 一致（防手改时只改一处） */
  const cliText = await readFile('resources/yan-cli/yan.mjs', 'utf8')
  /*
   * 按**组名**取动作表，不能抓「第一个 `actions:`」——
   * 那会让断言随着 GROUP_SPECS 的书写顺序改变而误判（加了 subagent 组就撞过一次）。
   */
  const specActions = (group) => {
    const block =
      new RegExp(`${group}:\\s*\\{[\\s\\S]*?actions:\\s*\\[([\\s\\S]*?)\\]`).exec(cliText)?.[1] ?? ''
    return [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  }
  const usageText = (group) => new RegExp(`${group}: \`([\\s\\S]*?)\``).exec(cliText)?.[1] ?? ''
  const browserActions = specActions('browser')
  ok(
    browserActions.includes('navigate') && browserActions.includes('request-user-control'),
    'yan CLI：动作表里有 navigate / request-user-control'
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
  /* 项目知识（实施-03 S4）：三个动作都要既能被发现，也有用途说明 */
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

  /*
   * 目标状态（实施-05 S3）：三道必须同时成立 ——
   * CLI 有动作表、用法里每个动作都有说明、宿主 KNOWN_COMMANDS 已登记。
   * 漏一处就是模型看到命令、发起请求，然后收到「unknown_command」这类接线语。
   */
  const goalActions = specActions('goal')
  ok(
    goalActions.join(',') === 'ready,report,status',
    'yan CLI：目标状态动作表已登记（ready / report / status）',
    goalActions.join(', ')
  )
  const goalUndocumented = goalActions.filter((action) => !usageText('goal').includes(action))
  ok(goalUndocumented.length === 0, 'yan CLI：目标状态每个动作都在用法里（不漏文案）', goalUndocumented.join(', '))
  const goalHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'goal', '--help'], { encoding: 'utf8' })
  ok(goalHelp.status === 0 && /ready/.test(goalHelp.stdout ?? ''), 'yan CLI：goal 分组帮助可按需读取')
  const capabilityServerText = await readFile('src/main/capability-server.ts', 'utf8')
  const unregistered = goalActions
    .map((action) => `goal.${action}`)
    .filter((command) => !capabilityServerText.includes(`'${command}'`))
  ok(unregistered.length === 0, 'yan CLI：目标状态命令已在宿主 KNOWN_COMMANDS 登记', unregistered.join(', '))
}

console.log(`\n${pass}/${pass + fail} 通过`)
await rm(dataDir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
