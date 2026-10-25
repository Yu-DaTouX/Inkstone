import { GAMETEST_TIMEOUT_MS, planGameTests, runGameTests, summarizeGameTestPlan, summarizeGameTests } from '../src/core/dev/gametest.ts'
import { jbrCandidatePaths } from '../src/core/dev/jbr.ts'
import { failure, text, type ToolDefinition } from './protocol.ts'
import type { McpContext } from './tools.ts'

const PROJECT_PROPERTY = { type: 'string', description: 'Fabric mod 项目根目录（含 build.gradle）。省略时用 INKSTONE_MC_PROJECT 或当前目录' }

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = typeof args[key] === 'string' ? Number(args[key]) : args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function createTestTools(context: McpContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'mc_test',
      title: '跑 GameTest',
      description: [
        '跑项目的 GameTest 并返回通过数、失败项和 junit 报告路径，不用离开 MCP 去敲 gradlew。',
        'action=run（默认）执行测试；action=list 只看检测到的运行配置、要用的 JDK 和客户端状态，不跑。',
        'side：server（默认，一般是 runGametest）、client（runClientGametest 这类客户端测试）、both（按配置各跑一次）。task 可直接指定 Gradle 任务名覆盖检测结果。',
        'filter：测试名过滤器。项目自己定义了过滤属性时用项目的方式传（ThePit 的 runGametest 是 -Pfilters="thepit:*combat*"，客户端是 -Pcfilters=子串）；项目没有定义时按 Fabric 原生方式传 -Dfabric-api.gametest.filter（只对项目自己转发给游戏 JVM 的构建生效）。服务端过滤器是通配符、必须带命名空间、一次一个；匹配不到时报告里是 0 项。',
        'JDK：按项目 build.gradle 的 release / toolchain（没有再按 Minecraft 版本）挑，同版本优先用插件下载的 JBR，返回实际用的 java 路径；找不到会直接说明缺哪个版本。',
        '开发客户端在运行时：控制方是 Agent 就先停掉再跑（restart_client=true 跑完自动重启并回到原来的世界），控制方是用户则拒绝并提示先交还。测试报告默认是 build/junit.xml，也会按项目里的 -D...gametest.report-file 和 build 目录里最新的 junit*.xml 找。'
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: { type: 'string', enum: ['run', 'list'], description: '默认 run' },
          filter: { type: 'string', description: '测试名过滤，例如 thepit:*combat*（服务端通配符）或客户端子串' },
          side: { type: 'string', enum: ['server', 'client', 'both'], description: '默认 server' },
          task: { type: 'string', description: '直接指定 Gradle 任务名，例如 runGametest' },
          restart_client: { type: 'boolean', description: '测试前停掉的客户端在测试后自动重启（默认 false）' },
          timeout_seconds: { type: 'number', description: `每个运行配置的超时秒数，默认 ${GAMETEST_TIMEOUT_MS / 1000}` }
        }
      },
      run: async (args) => {
        const project = context.project(args)
        const session = await project.status().catch(() => null)
        const client = session ? { running: session.state === 'running' || session.state === 'starting', owner: session.control?.owner ?? null } : null
        const javaPaths = [...(await jbrCandidatePaths(context.options.runtimesDir).catch(() => [])), ...context.options.javaPaths]
        if (str(args, 'action') === 'list') return text(summarizeGameTestPlan(await planGameTests(project.projectDir, javaPaths), client))
        const side = str(args, 'side') === 'both' ? 'both' : str(args, 'side') === 'client' ? 'client' : 'server'
        const world = session?.world ?? null
        try {
          const result = await runGameTests({
            projectDir: project.projectDir,
            filter: str(args, 'filter') ?? null,
            side,
            task: str(args, 'task') ?? null,
            javaPaths,
            timeoutMs: Math.max(30, num(args, 'timeout_seconds') ?? GAMETEST_TIMEOUT_MS / 1000) * 1000,
            client,
            restartAfter: args.restart_client === true,
            stopClient: () => project.stop().then(() => undefined),
            restartClient: () => project.launch({ projectDir: project.projectDir, world, maxMemoryMb: context.options.maxMemoryMb }).then(() => undefined)
          })
          const body = `${result.stoppedClient && !result.restartedClient ? '开发客户端已为测试停止，尚未重启；继续实机测试请用 mc_run action=start，或下次传 restart_client=true。\n' : ''}${summarizeGameTests(result)}`
          return result.ok ? text(body) : failure(body)
        } catch (error) {
          return failure(`跑 GameTest 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  ]
  const hints: Record<string, Record<string, boolean>> = {
    mc_test: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
  return tools.map((tool) => ({ ...tool, annotations: { title: tool.title, ...hints[tool.name] } }))
}
