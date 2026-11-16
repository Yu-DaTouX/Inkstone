import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await runSuite(import.meta.url, async (ok, compile) => {
  const { watchModelsFile, noteModelsWritten } = await compile('src/main/models-watch.ts')

  const makeFake = (initial) => {
    const state = { text: initial, listener: null, errorCb: null, closed: 0, opens: 0 }
    const opts = {
      file: join('X:', 'agent', 'models.json'),
      debounceMs: 20,
      retryMs: 20,
      read: async () => state.text,
      watch: (_dir, listener) => {
        state.opens++
        state.listener = listener
        return { close: () => { state.closed++ }, on: (_event, cb) => { state.errorCb = cb } }
      }
    }
    return { state, opts }
  }

  {
    const { state, opts } = makeFake('{"providers":{}}')
    let changes = 0
    const watcher = watchModelsFile({ ...opts, onChange: () => { changes++ } })
    await sleep(30)
    ok(changes === 0, '启动时的现有内容只作基线，不触发刷新')
    state.text = '{"providers":{"a":{}}}'
    state.listener('change', 'models.json')
    state.listener('rename', 'models.json')
    state.listener('change', 'models.json')
    await sleep(80)
    ok(changes === 1, '连续多次事件防抖后只刷新一次', String(changes))
    state.listener('change', 'models.json')
    await sleep(60)
    ok(changes === 1, '内容没变的事件不触发刷新')
    state.listener('change', 'other.json')
    state.listener('change', 'models.json.bak-yan-auto-1')
    state.text = '{"providers":{"b":{}}}'
    await sleep(60)
    ok(changes === 1, '同目录其他文件的事件被忽略')
    state.listener('rename', null)
    await sleep(60)
    ok(changes === 2, '文件名缺失的事件也会检查内容')
    state.text = '{"providers":'
    state.listener('change', 'models.json')
    await sleep(60)
    ok(changes === 2, '写到一半的非法 JSON 不触发刷新')
    state.text = '{"providers":{"c":{}}}'
    state.listener('change', 'models.json')
    await sleep(60)
    ok(changes === 3, '修好后的合法内容触发刷新')
    noteModelsWritten('{"providers":{"mine":{}}}\n')
    state.text = '{"providers":{"mine":{}}}\n'
    state.listener('change', 'models.json')
    await sleep(60)
    ok(changes === 3, '砚自己保存的内容不会再触发一次刷新')
    watcher.close()
    state.text = '{"providers":{"d":{}}}'
    state.listener('change', 'models.json')
    await sleep(60)
    ok(changes === 3 && state.closed === 1, '关闭后不再刷新并释放监听')
  }

  {
    const { state, opts } = makeFake('{"a":1}')
    let changes = 0
    const watcher = watchModelsFile({ ...opts, onChange: () => { changes++ } })
    await sleep(30)
    state.text = null
    state.listener('rename', 'models.json')
    await sleep(25)
    state.text = '{"a":2}'
    await sleep(60)
    ok(changes === 1, '先删除再写入（编辑器改名保存）的短暂缺失期容忍，只刷新一次', String(changes))
    state.text = null
    state.listener('rename', 'models.json')
    await sleep(100)
    ok(changes === 2, '文件确实被删除时刷新')
    watcher.close()
  }

  {
    const { state, opts } = makeFake('{}')
    let changes = 0
    const watcher = watchModelsFile({ ...opts, onChange: () => { changes++ } })
    await sleep(20)
    state.errorCb()
    await sleep(60)
    ok(state.opens === 2 && state.closed === 1, '监听出错后关闭旧句柄并重新建立')
    state.text = '{"x":1}'
    state.listener('change', 'models.json')
    await sleep(60)
    ok(changes === 1, '重建后的监听仍然有效')
    watcher.close()
  }

  {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-models-watch-'))
    try {
      const file = join(dir, 'models.json')
      await writeFile(file, '{"providers":{}}')
      let changes = 0
      const watcher = watchModelsFile({ file, debounceMs: 60, onChange: () => { changes++ } })
      await sleep(150)
      await writeFile(join(dir, 'models.json.tmp'), '{"providers":{"edited":{}}}')
      await rename(join(dir, 'models.json.tmp'), file)
      await sleep(600)
      ok(changes === 1, '真实文件系统：改名覆盖写入被监听到', String(changes))
      await writeFile(file, '{"providers":{"edited":{},"more":{}}}')
      await sleep(600)
      ok(changes === 2, '真实文件系统：原地写入被监听到', String(changes))
      watcher.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})
