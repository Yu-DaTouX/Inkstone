import { AsyncLocalStorage } from 'node:async_hooks'

export class SessionScope {
  private readonly storage = new AsyncLocalStorage<string>()

  current(): string | undefined {
    return this.storage.getStore()
  }

  run<T>(sessionId: string, work: () => T): T {
    return this.storage.run(sessionId, work)
  }

  bind<T extends object>(target: T, sessionId: string): T {
    return new Proxy(target, {
      get: (object, property) => {
        const value = Reflect.get(object, property, object)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => this.run(sessionId, () => (value as (...rest: unknown[]) => unknown).apply(object, args))
      }
    })
  }
}
