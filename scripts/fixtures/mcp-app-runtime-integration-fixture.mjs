export const BrowserWindow = class {}
export const session = { fromPartition: () => ({}) }

export function delayingNativeConfigReader(readReal, delays = {}) {
  let index = 0
  const started = new Set()
  return {
    started,
    get index() {
      return index
    },
    reader: async (path) => {
      index += 1
      const current = index
      const delay = delays[current]
      if (delay) {
        started.add(current)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      return readReal(path)
    }
  }
}
