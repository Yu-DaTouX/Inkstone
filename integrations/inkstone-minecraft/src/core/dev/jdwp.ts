import { Socket, connect } from 'node:net'

const HANDSHAKE = 'JDWP-Handshake'
const REPLY_FLAG = 0x80

export const JDWP_ERRORS: Record<number, string> = {
  21: 'INVALID_CLASS',
  41: 'INVALID_OBJECT',
  60: 'INVALID_CLASS_FORMAT',
  61: 'CIRCULAR_CLASS_DEFINITION',
  62: 'FAILS_VERIFICATION',
  63: 'ADD_METHOD_NOT_IMPLEMENTED',
  64: 'SCHEMA_CHANGE_NOT_IMPLEMENTED',
  65: 'INVALID_TYPESTATE',
  66: 'HIERARCHY_CHANGE_NOT_IMPLEMENTED',
  67: 'DELETE_METHOD_NOT_IMPLEMENTED',
  68: 'UNSUPPORTED_VERSION',
  69: 'NAMES_DONT_MATCH',
  70: 'CLASS_MODIFIERS_CHANGE_NOT_IMPLEMENTED',
  71: 'METHOD_MODIFIERS_CHANGE_NOT_IMPLEMENTED',
  72: 'CLASS_ATTRIBUTE_CHANGE_NOT_IMPLEMENTED',
  99: 'NOT_IMPLEMENTED',
  112: 'VM_DEAD'
}

export const SCHEMA_ERRORS = new Set([63, 64, 66, 67, 70, 71, 72])

export function describeJdwpError(code: number): string {
  const name = JDWP_ERRORS[code] ?? `ERROR_${code}`
  const hints: Record<number, string> = {
    63: '新增了方法',
    64: '新增或删除了字段、改了类结构',
    66: '改了父类或接口',
    67: '删除了方法',
    70: '改了类修饰符',
    71: '改了方法修饰符',
    72: '改了类属性（例如内部类、record 组件）',
    62: '字节码校验失败',
    60: '类文件格式无效'
  }
  return hints[code] ? `${name}（${hints[code]}）` : name
}

export class JdwpError extends Error {
  readonly code: number
  constructor(code: number, context: string) {
    super(`${context}：${describeJdwpError(code)}`)
    this.code = code
  }
}

export interface IdSizes {
  fieldId: number
  methodId: number
  objectId: number
  referenceTypeId: number
  frameId: number
}

export interface LoadedClass {
  tag: number
  typeId: bigint
  status: number
}

export class PacketWriter {
  private readonly parts: Buffer[] = []

  int(value: number): this {
    const buffer = Buffer.alloc(4)
    buffer.writeInt32BE(value)
    this.parts.push(buffer)
    return this
  }

  byte(value: number): this {
    this.parts.push(Buffer.from([value & 0xff]))
    return this
  }

  string(value: string): this {
    const bytes = Buffer.from(value, 'utf8')
    this.int(bytes.length)
    this.parts.push(bytes)
    return this
  }

  id(value: bigint, size: number): this {
    const buffer = Buffer.alloc(size)
    let rest = value
    for (let index = size - 1; index >= 0; index--) {
      buffer[index] = Number(rest & 0xffn)
      rest >>= 8n
    }
    this.parts.push(buffer)
    return this
  }

  bytes(value: Uint8Array): this {
    this.int(value.length)
    this.parts.push(Buffer.from(value))
    return this
  }

  build(): Buffer {
    return Buffer.concat(this.parts)
  }
}

export class PacketReader {
  private offset = 0
  private readonly buffer: Buffer

  constructor(buffer: Buffer) {
    this.buffer = buffer
  }

  int(): number {
    const value = this.buffer.readInt32BE(this.offset)
    this.offset += 4
    return value
  }

  byte(): number {
    return this.buffer[this.offset++]
  }

  id(size: number): bigint {
    let value = 0n
    for (let index = 0; index < size; index++) value = (value << 8n) | BigInt(this.buffer[this.offset + index])
    this.offset += size
    return value
  }

  string(): string {
    const length = this.int()
    const value = this.buffer.toString('utf8', this.offset, this.offset + length)
    this.offset += length
    return value
  }
}

export function encodeCommand(id: number, commandSet: number, command: number, data: Buffer): Buffer {
  const header = Buffer.alloc(11)
  header.writeUInt32BE(11 + data.length, 0)
  header.writeUInt32BE(id, 4)
  header[8] = 0
  header[9] = commandSet
  header[10] = command
  return Buffer.concat([header, data])
}

interface Pending {
  resolve(reply: { error: number; data: Buffer }): void
  reject(error: Error): void
}

export class JdwpClient {
  private socket: Socket | null = null
  private buffer = Buffer.alloc(0)
  private handshaken = false
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private sizes: IdSizes | null = null

  static async connect(port: number, host = '127.0.0.1', timeoutMs = 5000): Promise<JdwpClient> {
    const client = new JdwpClient()
    await client.open(port, host, timeoutMs)
    return client
  }

  private open(port: number, host: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ port, host })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`连接 JDWP ${host}:${port} 超时（可能已有调试器连着）`))
      }, timeoutMs)
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`连接 JDWP ${host}:${port} 失败：${error.message}`))
      })
      socket.once('connect', () => socket.write(HANDSHAKE))
      socket.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        if (!this.handshaken) {
          if (this.buffer.length < HANDSHAKE.length) return
          if (this.buffer.toString('latin1', 0, HANDSHAKE.length) !== HANDSHAKE) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error('JDWP 握手失败'))
            return
          }
          this.buffer = this.buffer.subarray(HANDSHAKE.length)
          this.handshaken = true
          this.socket = socket
          clearTimeout(timer)
          resolve()
        }
        this.drain()
      })
      socket.on('close', () => {
        for (const waiter of this.pending.values()) waiter.reject(new Error('JDWP 连接已关闭'))
        this.pending.clear()
        this.socket = null
      })
    })
  }

  private drain(): void {
    while (this.buffer.length >= 11) {
      const length = this.buffer.readUInt32BE(0)
      if (this.buffer.length < length) return
      const packet = this.buffer.subarray(0, length)
      this.buffer = this.buffer.subarray(length)
      const id = packet.readUInt32BE(4)
      const flags = packet[8]
      if (!(flags & REPLY_FLAG)) continue
      const waiter = this.pending.get(id)
      if (!waiter) continue
      this.pending.delete(id)
      waiter.resolve({ error: packet.readUInt16BE(9), data: packet.subarray(11) })
    }
  }

  private send(commandSet: number, command: number, data: Buffer = Buffer.alloc(0), context = `命令 ${commandSet}/${command}`): Promise<PacketReader> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('JDWP 未连接'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: ({ error, data: body }) => (error ? reject(new JdwpError(error, context)) : resolve(new PacketReader(body))),
        reject
      })
      socket.write(encodeCommand(id, commandSet, command, data))
    })
  }

  async idSizes(): Promise<IdSizes> {
    if (this.sizes) return this.sizes
    const reader = await this.send(1, 7, undefined, 'IDSizes')
    this.sizes = { fieldId: reader.int(), methodId: reader.int(), objectId: reader.int(), referenceTypeId: reader.int(), frameId: reader.int() }
    return this.sizes
  }

  async version(): Promise<{ description: string; vmVersion: string; vmName: string }> {
    const reader = await this.send(1, 1, undefined, 'Version')
    const description = reader.string()
    reader.int()
    reader.int()
    const vmVersion = reader.string()
    const vmName = reader.string()
    return { description, vmVersion, vmName }
  }

  async canRedefine(): Promise<{ redefine: boolean; addMethod: boolean; unrestricted: boolean }> {
    const reader = await this.send(1, 17, undefined, 'CapabilitiesNew')
    const flags: boolean[] = []
    for (let index = 0; index < 32; index++) flags.push(reader.byte() !== 0)
    return { redefine: flags[7], addMethod: flags[8], unrestricted: flags[9] }
  }

  async classesBySignature(signature: string): Promise<LoadedClass[]> {
    const sizes = await this.idSizes()
    const reader = await this.send(1, 2, new PacketWriter().string(signature).build(), `ClassesBySignature ${signature}`)
    const count = reader.int()
    const classes: LoadedClass[] = []
    for (let index = 0; index < count; index++) classes.push({ tag: reader.byte(), typeId: reader.id(sizes.referenceTypeId), status: reader.int() })
    return classes
  }

  async redefineClasses(entries: Array<{ typeId: bigint; bytes: Uint8Array }>): Promise<void> {
    if (!entries.length) return
    const sizes = await this.idSizes()
    const writer = new PacketWriter().int(entries.length)
    for (const entry of entries) writer.id(entry.typeId, sizes.referenceTypeId).bytes(entry.bytes)
    await this.send(1, 18, writer.build(), 'RedefineClasses')
  }

  async dispose(): Promise<void> {
    if (!this.socket) return
    try {
      await Promise.race([this.send(1, 6, undefined, 'Dispose'), new Promise((resolve) => setTimeout(resolve, 1000))])
    } catch {
    }
    this.close()
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
  }
}

export function classSignature(binaryName: string): string {
  return `L${binaryName.replaceAll('.', '/')};`
}
