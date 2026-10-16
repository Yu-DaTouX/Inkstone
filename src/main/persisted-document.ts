export function parsePersistedDocument(text: string, fields: Record<string, 'array' | 'object'>): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('持久文档必须是对象，已拒绝覆盖')
  const document = value as Record<string, unknown>
  if (document.version !== undefined && document.version !== 1) throw new Error('持久文档版本不受支持，已拒绝覆盖')
  for (const [field, type] of Object.entries(fields)) {
    const item = document[field]
    if (type === 'array' ? !Array.isArray(item) : !item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`持久文档字段 ${field} 格式无效，已拒绝覆盖`)
    }
  }
  return document
}
