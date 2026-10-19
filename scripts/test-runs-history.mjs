import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

function record(at, runId = 'r1') {
  return {
    runId,
    code: 'S1',
    kind: 'session',
    sessionId: 's1',
    title: '标题',
    startedAt: at,
    endedAt: at,
    terminal: 'done',
    segments: [{ phase: 'running', from: at, to: at }],
    counts: { tools: 0, edits: 0, errors: 0 }
  }
}

export async function runRunsHistoryTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-runs-history-'))
  process.env.YAN_DATA_DIR = join(dir, 'default-data')
  try {
    const { DurableRunHistory, MemoryRunHistory, runHistoryPath } = await compile('src/main/runs/history.ts', join(dir, 'history.mjs'))

    const day = new Date(2026, 0, 2, 12, 0, 0).getTime()
    assert.equal(runHistoryPath(day, '/root'), join('/root', 'runs', '2026-01-02.jsonl'))
    const padded = new Date(2026, 10, 3, 8, 0, 0).getTime()
    assert.equal(runHistoryPath(padded, '/root'), join('/root', 'runs', '2026-11-03.jsonl'), '月日补零')
    assert.equal(runHistoryPath(day), join(process.env.YAN_DATA_DIR, 'runs', '2026-01-02.jsonl'), '默认根目录取 YAN_DIR')

    {
      const written = []
      const history = new DurableRunHistory('/root', { write: async (path, text, mode) => { written.push({ path, text, mode }) } })
      await history.append(record(day, 'r1'))
      await history.append(record(day, 'r2'))
      assert.equal(written.length, 2)
      assert.deepEqual(written.map((item) => item.path), [runHistoryPath(day, '/root'), runHistoryPath(day, '/root')])
      assert.equal(written[0].mode, 'append')
      assert.ok(written[0].text.endsWith('\n'))
      assert.equal(JSON.parse(written[0].text).runId, 'r1')
      assert.equal(JSON.parse(written[1].text).runId, 'r2')
      await history.whenIdle()
    }

    {
      const written = []
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const history = new DurableRunHistory('/root', {
        write: async (path, text) => {
          if (written.length === 0) await gate
          written.push(path)
        }
      })
      const first = history.append(record(day, 'slow'))
      const second = history.append(record(day, 'fast'))
      await new Promise((resolve) => setTimeout(resolve, 5))
      assert.deepEqual(written, [], '先到的写盘未完成前不并发写')
      release()
      await Promise.all([first, second])
      assert.equal(written.length, 2)
      await history.whenIdle()
    }

    {
      const history = new DurableRunHistory('/root', {
        write: async (_path, text) => {
          if (text.includes('boom')) throw new Error('disk full')
        }
      })
      await assert.rejects(() => history.append(record(day, 'boom')), /disk full/)
      await history.append(record(day, 'ok'))
      await history.whenIdle()
    }

    {
      const root = join(dir, 'real')
      const history = new DurableRunHistory(root)
      const at = new Date(2026, 4, 6, 9, 30, 0).getTime()
      await history.append(record(at, 'a1'))
      await history.append(record(at, 'a2'))
      await history.whenIdle()
      const text = await readFile(join(root, 'runs', '2026-05-06.jsonl'), 'utf8')
      const lines = text.trim().split('\n')
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).runId, 'a1')
      assert.equal(JSON.parse(lines[1]).runId, 'a2')
    }

    {
      const memory = new MemoryRunHistory()
      await memory.append(record(day, 'm1'))
      await memory.append(record(day, 'm2'))
      assert.deepEqual(memory.records.map((item) => item.runId), ['m1', 'm2'])
    }
  } finally {
    delete process.env.YAN_DATA_DIR
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRunsHistoryTests()
  console.log('runs-history: 全部通过')
}
