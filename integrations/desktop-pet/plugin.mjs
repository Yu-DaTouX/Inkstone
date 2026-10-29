import { fileURLToPath } from 'node:url'
import * as pet from './controller.mjs'
import { requestHost } from './bridge.mjs'

pet.configureDesktopPet({
  runnerPath: () => fileURLToPath(new URL('./runner.mjs', import.meta.url)),
  showMainWindow: () => { void requestHost('window.show', {}).catch(() => undefined) }
})

const commands = {
  status: () => pet.desktopPetStatus(),
  install: () => pet.installDesktopPet(),
  start: () => pet.startDesktopPet(),
  stop: () => pet.stopDesktopPet(),
  uninstall: () => pet.uninstallDesktopPet(),
  autoStart: enabled => pet.setDesktopPetAutoStart(enabled === true),
  setModel: model => pet.setDesktopPetModel(typeof model === 'string' ? model : null)
}
let queue = Promise.resolve()
process.on('message', message => {
  if (message?.type === 'event' && message.channel === 'runs') pet.feedDesktopPetRuns(message.payload)
  if (message?.type !== 'request') return
  const run = async () => {
    try {
      const command = commands[message.action]
      if (typeof command !== 'function' || !Object.hasOwn(commands, message.action)) throw new Error('未知插件操作')
      const value = await command(message.params)
      process.send?.({ type: 'response', id: message.id, value })
    } catch (error) {
      process.send?.({ type: 'response', id: message.id, error: String(error.message ?? error) })
    }
  }
  queue = queue.then(run, run)
})
process.on('disconnect', () => { pet.stopDesktopPetSync(); process.exit(0) })
process.on('SIGTERM', () => { pet.stopDesktopPetSync(); process.exit(0) })
await pet.autoStartDesktopPet()
process.send?.({ type: 'ready' })
