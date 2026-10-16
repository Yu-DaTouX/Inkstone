let writeTail: Promise<unknown> = Promise.resolve()

export function serializedWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeTail.then(operation, operation)
  writeTail = result.catch(() => undefined)
  return result
}
