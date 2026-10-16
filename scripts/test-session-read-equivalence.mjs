import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const line = (value) => JSON.stringify(value) + '\n'
const head = (id = 'fixture') => line({ type: 'session', version: 3, id, cwd: 'C:/synthetic-project' })
const message = (id, role, content, extra = {}) => line({ type: 'message', id, message: { role, content, ...extra } })
const localize = (mimeType, data) => `file://${mimeType}/${data.length}`

const MIXED =
  head() +
  message('sys', 'system', 'skip-this-system-entry') +
  message('u', 'user', [{ type: 'text', text: '中文🙂用户' }]) +
  message('a', 'assistant', [
    { type: 'thinking', thinking: '分析' },
    { type: 'text', text: '答复' },
    { type: 'toolCall', id: 'call1', name: 'bash', arguments: { command: 'echo ok' } }
  ]) +
  message('t', 'toolResult', [{ type: 'text', text: 'ok' }], {
    toolCallId: 'call1',
    toolName: 'bash',
    isError: false,
    nestedCalls: { complete: false, calls: [{ id: 'call1/child', name: 'read', status: 'unfinished', arguments: { path: 'a' } }] }
  }) +
  message('orphan', 'toolResult', 'oops', { toolCallId: 'none', toolName: 'read', isError: true }) +
  line({ type: 'message', message: null }) +
  line({ type: 'custom', customType: 'fixture' }) +
  'this line is not json\n' +
  message('last', 'assistant', '尾部').trimEnd()

export const FIXTURES = {
  empty: '',
  header: head(),
  mixed: MIXED,
  bom: '\uFEFF' + head() + message('u', 'user', 'BOM 之后的消息'),
  crlf: (head() + message('u', 'user', 'CRLF')).replaceAll('\n', '\r\n'),
  truncated: head() + message('u', 'user', '完整') + '{"type":"message","message":',
  utf8: head() + message('u', 'user', 'x'.repeat(65400) + '中文🙂'.repeat(1000)),
  images:
    head() +
    message('u', 'user', [{ type: 'text', text: '图' }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(70000) }]) +
    message('a', 'assistant', [{ type: 'toolCall', id: 'big', name: 'bash', arguments: { command: 'x'.repeat(70000) } }]) +
    message('t', 'toolResult', [{ type: 'text', text: 'y'.repeat(100000) }], { toolCallId: 'big', toolName: 'bash', isError: false }),
  oversized: head() + message('big', 'user', 'z'.repeat(48 * 1024 * 1024 + 1)) + message('small', 'user', '仍可读取')
}

export async function runSessionReadEquivalenceTests(ok = (value, label) => assert.ok(value, label)) {
  console.log('\n--- 会话读取：等价与边界（固定夹具） ---')
  const root = await mkdtemp(join(tmpdir(), 'yan-reader-equiv-'))
  try {
    const moduleFile = join(root, 'reader.mjs')
    await build({ entryPoints: ['src/main/session-reader.ts'], bundle: true, platform: 'node', format: 'esm', outfile: moduleFile })
    const { readSessionMessages } = await import(pathToFileURL(moduleFile))
    const files = {}
    for (const [name, raw] of Object.entries(FIXTURES)) {
      files[name] = join(root, `${name}.jsonl`)
      await writeFile(files[name], raw)
    }
    const read = (name) => readSessionMessages(files[name], { localizeImage: localize })

    const empty = await read('empty')
    ok(empty.total === 0 && empty.truncated === 0 && empty.bytes === 0, '空文件：0 条、无截断、0 字节')
    ok(empty.messages.length === 0 && empty.sessionId === undefined, '空文件：没有消息与会话 id')

    const headerOnly = await read('header')
    ok(headerOnly.total === 0 && headerOnly.messages.length === 0, '只有文件头：不产出消息')
    ok(headerOnly.sessionId === 'fixture' && headerOnly.sourceCwd === 'C:/synthetic-project', '文件头给出会话 id 与来源 cwd')
    ok(headerOnly.bytes === Buffer.byteLength(FIXTURES.header), 'bytes 是文件字节数')

    const mixed = await read('mixed')
    ok(mixed.total === 6, `坏行/非消息行不计入 total（实际 ${mixed.total}，期望 6）`)
    ok(mixed.truncated === 0, '正常夹具没有截断标记')
    ok(mixed.messages.length === 4, `system 被跳过、toolResult 挂回调用（实际 ${mixed.messages.length}，期望 4）`)
    ok(mixed.messages.map((m) => m.id).join(',') === 'm0,m1,m2,m3', '消息 id 按产出序号连续编号（m0..m3）')
    ok(mixed.messages.map((m) => m.entryId).join(',') === 'u,a,orphan,last', 'entryIds 逐条保留（分叉锚点）')
    ok(mixed.messages[0].role === 'user' && mixed.messages[0].text === '中文🙂用户', '用户文本逐字保留（含 emoji）')
    const call = mixed.messages[1].toolCalls ?? []
    ok(call[0]?.id === 'call1' && call[0].name === 'bash' && call[0].status === 'ok', '工具调用与结果配成同一个调用')
    ok(call[0]?.output === 'ok', '工具结果挂到原调用上，不新增消息')
    ok(call[0]?.nestedCallsIncomplete === true && call[1]?.id === 'call1/child', '嵌套调用保留并标记不完整')
    ok(mixed.messages[2].toolCalls?.[0]?.status === 'error', '没有配对调用的 toolResult 仍标为错误')

    const bom = await read('bom')
    ok(bom.total === 1 && bom.messages[0].text === 'BOM 之后的消息', 'BOM：文件头带 BOM 时仍能读出消息')
    const crlf = await read('crlf')
    ok(crlf.total === 1 && crlf.messages[0].text === 'CRLF', 'CRLF：按行切分正确')
    ok(crlf.sessionId === 'fixture', 'CRLF：文件头也能读出会话 id')

    const cut = await read('truncated')
    ok(cut.total === 1 && cut.messages.length === 1, '末尾半条 JSON 被跳过，不新增消息')
    ok(cut.messages[0].text === '完整', '截断行之前的完整消息仍读得到')

    const utf8 = await read('utf8')
    ok(utf8.total === 1 && utf8.truncated === 1, '超长文本：整条保留并计一次截断')
    ok(/已截断/.test(utf8.messages[0].text), '超长文本带可见截断标记')
    ok(!utf8.messages[0].text.includes('\uFFFD'), '跨块 UTF-8 不产生替换字符')
    ok(utf8.bytes === Buffer.byteLength(FIXTURES.utf8), '多字节文件 bytes 用字节数（不是字符数）')

    const images = await read('images')
    ok(images.total === 3 && images.messages.length === 2, '图片夹具：3 条记录合成 2 条消息')
    const image = images.messages[0].images?.[0]
    ok(image?.url === 'file://image/png/70000' && image?.data === '', '图片经 localizeImage 落盘，消息里不留 base64')
    ok(images.messages[1].toolCalls?.[0]?.output?.includes('已截断'), '工具结果超长时截断并标记')
    ok(images.truncated >= 2, `图片夹具的截断计数计入参数与输出（实际 ${images.truncated}）`)

    const oversized = await read('oversized')
    ok(oversized.total === 1 && oversized.truncated === 1, '超过单行上限的整行被跳过并计一次截断')
    ok(oversized.messages[0].text === '仍可读取', '超长行之后的消息仍能读到')
    ok(oversized.bytes === Buffer.byteLength(FIXTURES.oversized), '超长行的文件仍报告真实字节数')

    ok((await readSessionMessages(join(root, 'missing.jsonl'))) === null, '文件不存在时返回 null（调用方回退）')
    ok((await stat(files.mixed)).isFile(), '夹具写在临时目录，不触碰仓库与用户数据')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runSessionReadEquivalenceTests()
  console.log('session-read-equivalence: 固定夹具等价检查通过')
}
