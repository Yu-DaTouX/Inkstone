let sequence = 0
const pending = new Map()
export function requestHost(capability, params, owner) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('宿主请求超时')) }, 65000)
    pending.set(id, { resolve, reject, timer, owner })
    process.send?.({ type: 'capability', id, capability, params })
  })
}
export function cancelHostRequest(owner) {
  for (const [id, item] of pending) {
    if (owner !== undefined && item.owner !== owner) continue
    clearTimeout(item.timer)
    pending.delete(id)
    item.reject(new Error('已取消'))
    process.send?.({ type: 'cancel', id })
  }
}
process.on('message', message => {
  if (message?.type !== 'capability-result') return
  const item = pending.get(message.id)
  if (!item) return
  pending.delete(message.id)
  clearTimeout(item.timer)
  if (message.error) item.reject(new Error(message.error))
  else item.resolve(message.value)
})
