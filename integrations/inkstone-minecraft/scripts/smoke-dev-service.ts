import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DevService } from '../src/core/dev/service.ts'
import { dataDir } from '../src/core/settings.ts'
import { createTools, McpContext } from '../mcp/tools.ts'

const [projectDir, outDir] = process.argv.slice(2)
if (!projectDir || !outDir) {
  console.error('用法：node scripts/smoke-dev-service.ts <项目目录> <输出目录>')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })
const service = new DevService({ dataDir: dataDir(), logPollMs: 300 })
const events = { session: 0, log: 0, sample: [] as string[] }
service.on('session', () => (events.session += 1))
service.on('log', (event: { text: string }) => {
  events.log += 1
  if (events.sample.length < 5) events.sample.push(event.text.slice(0, 160))
})
const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  const started = Date.now()
  const value = await run()
  console.log(`[${name}] ${Date.now() - started}ms`)
  return value
}
const savePng = (name: string, dataUrl: string) => writeFile(join(outDir, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))

const status = await step('status', () => service.status(projectDir))
console.log(JSON.stringify({ state: status.session.state, pid: status.session.pid, mixinHotswap: status.session.mixinHotswap, jbrFound: status.jbr.found }))

const tools = createTools(new McpContext({ runtimesDir: service.runtimesDir, javaPaths: [], maxMemoryMb: 4096, log: () => {} }))
const texture = tools.find((tool) => tool.name === 'mc_texture')!
const written = await step('mc_texture write', () =>
  texture.run({
    project: projectDir,
    action: 'write',
    texture: 'inkdemo:item/example_item',
    palette: { O: '#3a0d14', R: '#c8243a', H: '#ff8a9a', D: '#7a1424' },
    grid: [
      '................',
      '................',
      '......OOOO......',
      '.....ORRRRO.....',
      '....ORHHRRRO....',
      '...ORHHRRRRRO...',
      '...ORHRRRRRDO...',
      '...ORRRRRRRDO...',
      '...ORRRRRRDDO...',
      '....ORRRRDDO....',
      '.....ORRDDO.....',
      '......ODDO......',
      '.......OO.......',
      '................',
      '................',
      '................'
    ]
  })
)
const imagePart = written.content.find((part) => part.type === 'image')
if (imagePart?.data) await writeFile(join(outDir, 'texture-write-view.png'), Buffer.from(imagePart.data, 'base64'))
console.log(written.content.find((part) => part.type === 'text')?.text?.split('\n').slice(0, 3).join('\n'))

const reload = await step('reloadResources', () => service.reloadResources(projectDir))
console.log(JSON.stringify({ resourcesReloaded: reload.resourcesReloaded, changedAssets: reload.changedAssets, notes: reload.notes }))
await savePng('render-after-write.png', await step('render', () => service.render(projectDir, 'inkdemo:example_item', 'item', 256)))
console.log(JSON.stringify(await step('command', () => service.command(projectDir, 'time set noon'))))
await savePng('screen.png', await step('screenshot', () => service.screenshot(projectDir)))
console.log(`crashes: ${(await service.crashes(projectDir)).length}`)
console.log(`logs(ERROR): ${(await service.logs({ projectDir, lines: 20, levels: ['ERROR'] })).length} 行`)
await new Promise((resolve) => setTimeout(resolve, 1500))
const stopped = await step('stop', () => service.stop(projectDir))
console.log(JSON.stringify({ state: stopped.state, exitCode: stopped.exitCode }))
console.log(JSON.stringify(events, null, 1))
service.dispose()
