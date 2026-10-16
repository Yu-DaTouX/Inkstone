/**
 * A6R 跨层契约小测的**浏览器边界替身**（fake window / iframe / MessagePort）。
 *
 * 只模拟浏览器侧最小的 `addEventListener` / `postMessage` / `ports` 形状，
 * 不启动 Electron、不建真实 iframe、不联网。把这三件替身单独放这里，测试文件
 * 只负责证据断言，避免「宿主/渲染各写一套同样的假件」。
 */

/** 一个可手动 `emit` 的假 window（只处理 `message`）。 */
export function fakeWindow() {
  const listeners = new Set()
  return {
    listeners,
    addEventListener(type, fn) {
      if (type === 'message') listeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'message') listeners.delete(fn)
    },
    emit(event) {
      for (const fn of [...listeners]) fn(event)
    }
  }
}

/** 假 iframe 的 contentWindow：记录所有 `postMessage`。 */
export function fakeFrame() {
  const posted = []
  return {
    posted,
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin })
    }
  }
}

/** 假 MessagePort：可 emit / start / close。 */
export function fakePort() {
  const posted = []
  const listeners = new Set()
  return {
    posted,
    closed: false,
    started: false,
    postMessage(message) {
      posted.push(message)
    },
    addEventListener(type, fn) {
      if (type === 'message') listeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'message') listeners.delete(fn)
    },
    start() {
      this.started = true
    },
    close() {
      this.closed = true
    },
    emit(data) {
      for (const fn of [...listeners]) fn({ data })
    }
  }
}
