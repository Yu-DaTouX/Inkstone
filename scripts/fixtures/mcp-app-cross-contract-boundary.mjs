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

export function fakeFrame() {
  const posted = []
  return {
    posted,
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin })
    }
  }
}

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
