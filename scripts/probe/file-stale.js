/* H-4 文件变化提示：验证外部进程写入、保留旧内容、显式重新加载。 */
;(async () => {
  const out = []
  let ok = true
  const say = (condition, text) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text)
    if (!condition) ok = false
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  window.__YAN_PREVIEW_POLL_MS = 100

  try {
    const readyDeadline = Date.now() + 40000
    while (Date.now() < readyDeadline && (store.getState().conn !== 'ready' || !store.getState().settings)) {
      await sleep(100)
    }
    const cwd = store.getState().session?.cwd ?? store.getState().settings?.cwd ?? ''
    say(store.getState().conn === 'ready' && !!cwd, '砚已就绪并连接到隔离 fixture 项目')
    if (!cwd) throw new Error('fixture cwd is unavailable')

    await store.getState().previewFile('README.md', undefined, cwd)
    const loadedDeadline = Date.now() + 10000
    while (Date.now() < loadedDeadline && store.getState().filePreview?.loading) await sleep(50)
    const initial = store.getState().filePreview
    const initialText = initial?.data?.text ?? ''
    const initialMtime = initial?.data?.mtimeMs
    say(initial?.data?.ok === true && initialText.includes('fixture repo'), '预览打开并读取初始 README 内容')
    say(initial?.stale !== true, '首次读取时没有误报文件变化')

    const staleDeadline = Date.now() + 35000
    while (Date.now() < staleDeadline && store.getState().filePreview?.stale !== true) await sleep(100)
    const stale = store.getState().filePreview
    say(stale?.stale === true, '检测到外部进程写入后进入 stale 状态')
    say(
      stale?.data?.text === initialText && stale?.data?.mtimeMs === initialMtime,
      '提示出现时继续展示旧快照，没有自动替换内容'
    )
    say(!!document.querySelector('[data-testid="file-preview-updated"]'), '界面显示“内容已更新”提示')

    const reload = document.querySelector('[data-testid="file-preview-reload"]')
    say(!!reload, '提示提供显式重新加载按钮')
    reload?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const reloadDeadline = Date.now() + 10000
    while (
      Date.now() < reloadDeadline &&
      (store.getState().filePreview?.loading ||
        !store.getState().filePreview?.data?.text?.includes('EXTERNAL_PROCESS_CHANGE_H4'))
    ) {
      await sleep(50)
    }
    const reloaded = store.getState().filePreview
    say(
      reloaded?.data?.text?.includes('EXTERNAL_PROCESS_CHANGE_H4'),
      '点击重新加载后读到了外部进程写入的新内容'
    )
    say(reloaded?.stale !== true, '重新加载后 stale 提示清除')
    say(!document.querySelector('[data-testid="file-preview-updated"]'), '重新加载后更新提示从界面消失')
  } catch (error) {
    say(false, `探针异常：${error?.message ?? String(error)}`)
  }

  out.push(`filestale.assertionsFailed=${ok ? 0 : 1}`)
  return out.join('\n')
})()
