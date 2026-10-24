import { join } from 'node:path'
import { dataDir, loadDevSettings } from '../src/core/dev/settings.ts'
import { serveStdio } from './protocol.ts'
import { createToolsWithExtras, McpContext } from './tools.ts'

const INSTRUCTIONS = [
  'Inkstone Minecraft 开发工具：给 Fabric mod 开发用，开发客户端由 mc_run 启动并常驻。',
  '常规循环：改代码或资源 → mc_apply（热替换 / 资源重载 / 数据 /reload，必要时报告需要重启）→ mc_view 或 mc_command 验证 → 出错看 mc_logs。',
  '套路是「搭现场用命令，触发用输入与界面，再用查询和截图断言」：环境用 mc_command 或 mc_run 的 gamemode/difficulty/lang/time/weather 参数摆好，交互用 mc_input / mc_ui 真实按键点击，结果用 mc_inspect（含 what=player）、mc_chat、mc_perf、mc_view 连拍确认。要数坐标的界面截图加 grid（网格与刻度，和 mc_ui click 同一坐标系），盯目标用 mc_highlight，等条件用 mc_wait 而不是反复截图轮询。',
  '开发客户端必须用 JBR 启动以支持增强热替换；本机没有时第一次 mc_run start 会自动下载（约 100MB，只下一次），告知用户即可。',
  '看不懂贴图时用 mc_texture（放大 + 网格 + 调色板 + 像素字符图）；看游戏内效果用 mc_view target=item/block/screen。',
  '查 Minecraft 原版实现用 mc_source，名字对不上时用 mc_mapping。客户端语言等选项用 mc_options；测试用 mc_test；存档用 mc_world。详细规范见 inkstone-fabric-dev 技能。'
].join('\n')

const root = dataDir()
const settings = await loadDevSettings(join(root, 'settings.json'))
const context = new McpContext({
  runtimesDir: join(root, 'runtimes'),
  javaPaths: settings.extraJavaPaths,
  maxMemoryMb: settings.maxMemoryMb,
  log: (line) => process.stderr.write(`${line}\n`)
})
serveStdio(await createToolsWithExtras(context), { name: 'inkstone-minecraft', version: '0.1.0', instructions: INSTRUCTIONS })
