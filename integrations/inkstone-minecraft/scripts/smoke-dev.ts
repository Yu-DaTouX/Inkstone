import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../src/core/settings.ts'
import { DevProject } from '../src/core/dev/runner.ts'

const [projectDir, action = 'status', ...rest] = process.argv.slice(2)
if (!projectDir) {
  console.error('用法：node scripts/smoke-dev.ts <项目目录> <launch|status|apply|reload|command|screenshot|render|registry|block|entities|logs|crashes|stop|restart> [参数]')
  process.exit(2)
}
const project = new DevProject(projectDir, {
  runtimesDir: join(dataDir(), 'runtimes'),
  onLog: (text) => {
    if (process.env.INKSTONE_SMOKE_VERBOSE || !text.startsWith('[gradle]')) console.error(text)
  }
})
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))
switch (action) {
  case 'launch':
    print(await project.launch({ projectDir, world: rest[0] ?? undefined }))
    break
  case 'restart':
    print(await project.restart({ projectDir }))
    break
  case 'stop':
    print(await project.stop())
    break
  case 'status':
    print(await project.status())
    break
  case 'apply':
    print(await project.apply({ autoRestart: rest[0] === 'restart' }))
    break
  case 'reload':
    print(await project.reloadResources())
    break
  case 'command':
    print(await project.command(rest.join(' ')))
    break
  case 'screenshot':
    await writeFile(rest[0], await project.image('/screenshot'))
    console.log(rest[0])
    break
  case 'render':
    await writeFile(rest[1], await project.image('/render', { id: rest[0], size: Number(rest[2] ?? 128) }))
    console.log(rest[1])
    break
  case 'registry':
    print(await project.companion('/registry', { registry: rest[0] ?? '', filter: rest[1] ?? '' }))
    break
  case 'block':
    print(await project.companion('/block', { x: Number(rest[0]), y: Number(rest[1]), z: Number(rest[2]) }))
    break
  case 'entities':
    print(await project.companion('/entities', { radius: Number(rest[0] ?? 8) }))
    break
  case 'logs':
    console.log((await project.logs({ lines: Number(rest[0] ?? 80), filter: rest[1] })).join('\n'))
    break
  case 'crashes':
    print(await project.crashes())
    break
  default:
    console.error(`未知动作 ${action}`)
    process.exit(2)
}
