/**
 * 标题样本挑选（`src/shared/title-samples.ts`）的纯逻辑单测。
 *
 * 为什么单独测这个：它决定「标题代表谁」。之前这段规则在
 * `agent.ts`（内存消息）与 `sessions.ts`（JSONL）里各写了一份 ——
 * 一处改了另一处不知道，就会出现“新会话标题与旧会话标题口径不一样”，
 * 而这种差异在界面上只表现为“标题怪怪的”，很难归因。
 *
 * 磁盘那条路径（`readTitleSamples`）由 `test-unit.mjs` 的 1b 节覆盖，
 * 这里覆盖界面的内存消息路径（含图片消息）。
 */
export function runTitleSampleTests(ok, mod) {
  const { titleSamples, titleSampleText, titleSampleImages } = mod

  console.log('\n--- N11 标题样本：首条 + 最近一条 ---')

  const u = (text, images) => ({ text, images })

  /* ---- 1. 基本规则 ---- */
  {
    const one = titleSamples([u('只有一句')])
    ok(one.length === 1 && one[0] === '只有一句', '只有一条用户消息时不重复凑两条', JSON.stringify(one))

    const many = titleSamples([u('第一句'), u('第二句'), u('第三句'), u('最近一句')])
    ok(many.length === 2, '多条消息只取两条', JSON.stringify(many))
    ok(many[0] === '第一句' && many[1] === '最近一句', '取的是首条与最近一条（保序）', JSON.stringify(many))
  }

  /* ---- 2. 空白与图片 ---- */
  {
    const blank = titleSamples([u('   '), u('\n\t'), u('  ')])
    ok(blank.length === 0, '全是空白 → 没有样本（调用方此时不该发起请求）', JSON.stringify(blank))

    const imgOnly = titleSamples([u('', [{ data: 'a', mimeType: 'image/png' }])])
    ok(imgOnly.length === 1 && /图片 ×1/.test(imgOnly[0]), '纯图片消息用占位符当样本', JSON.stringify(imgOnly))

    const mixed = titleSamples([
      u('', [{ data: 'a', mimeType: 'image/png' }, { data: 'b', mimeType: 'image/png' }]),
      u('接着问一句')
    ])
    ok(mixed[0] === '[图片 ×2]' && mixed[1] === '接着问一句', '图片占位符与文字混排时顺序正确', JSON.stringify(mixed))

    const padded = titleSamples([u('  带空格  '), u('  结尾  ')])
    ok(padded[0] === '带空格' && padded[1] === '结尾', '样本两端空白被裁掉', JSON.stringify(padded))

    ok(titleSampleText(u('', [])) === '', '既没文字也没图 → 空样本')
  }

  /* ---- 3. 首图只带一张 ---- */
  {
    const imgs = titleSampleImages([
      u('首条', [{ data: 'a', mimeType: 'image/png' }, { data: 'b', mimeType: 'image/png' }])
    ])
    ok(imgs.length === 1 && imgs[0].data === 'a', '只带首条消息的第一张图（短请求别塞太多）', JSON.stringify(imgs))

    const later = titleSampleImages([u('首条没图'), u('第二条带图', [{ data: 'z', mimeType: 'image/webp' }])])
    ok(later.length === 0, '首条没图时不拿后面的图凑（示例说的是首条）', JSON.stringify(later))

    const none = titleSampleImages([u('纯文字')])
    ok(none.length === 0, '没有图片时返回空数组', JSON.stringify(none))
  }
}
