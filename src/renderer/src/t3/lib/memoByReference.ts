export function memoByReference<Key extends object, Value>(derive: (input: Key) => Value): (input: Key) => Value {
  const cache = new WeakMap<Key, { value: Value }>()
  return (input) => {
    const cached = cache.get(input)
    if (cached !== undefined) return cached.value
    const value = derive(input)
    cache.set(input, { value })
    return value
  }
}
