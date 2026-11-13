import { EventEmitter } from 'node:events'

export function fakePiEvents() {
  const emitter = new EventEmitter()
  return {
    emit: (channel, data) => { emitter.emit(channel, data) },
    on: (channel, handler) => {
      emitter.on(channel, handler)
      return () => emitter.off(channel, handler)
    }
  }
}
