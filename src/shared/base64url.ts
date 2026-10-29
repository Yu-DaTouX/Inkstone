export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function decodeBase64Url(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('不是 base64url')
  return new Uint8Array(Buffer.from(text, 'base64url'))
}
