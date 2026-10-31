import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

function conflict(extra) {
  return {
    id: 'c0',
    key: 'key',
    kind: 'prompt',
    detectedAt: 1,
    remoteDeviceId: 'dev',
    remoteDeviceName: '设备',
    remoteModifiedAt: 100,
    remoteHash: 'h',
    remotePayload: 'payload',
    suffix: '.conflict',
    ...extra
  }
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-sync-resolve-'))
  try {
    const { buildConflictCopy, supportsConflictCopy } = await compile('src/main/sync/resolve.ts', join(dir, 'resolve.mjs'))
    const { canonicalJson, shortHash } = await compile('src/main/sync/canonical.ts', join(dir, 'canonical.mjs'))

    for (const kind of ['prompt', 'skill', 'bookmark', 'schedule']) {
      assert.equal(supportsConflictCopy(kind), true, `${kind} 支持冲突副本`)
    }
    assert.equal(supportsConflictCopy('settings'), false)

    const prompt = buildConflictCopy(
      conflict({ kind: 'prompt', key: 'prompt:周报', remoteDeviceName: 'MacBook-Pro', remotePayload: 'P1', remoteModifiedAt: 111 })
    )
    assert.deepEqual(prompt, {
      key: `prompt:周报（MacBook-Pro-${shortHash('c0', 32)}）`,
      kind: 'prompt',
      payload: 'P1',
      modifiedAt: 111
    })

    const promptFallback = buildConflictCopy(conflict({ kind: 'prompt', key: 'prompt:笔记', remoteDeviceName: '   ' }))
    assert.equal(promptFallback.key, `prompt:笔记（未知设备-${shortHash('c0', 32)}）`)

    const promptSanitized = buildConflictCopy(conflict({ kind: 'prompt', key: 'prompt:笔记', remoteDeviceName: 'a//b**c' }))
    assert.equal(promptSanitized.key, `prompt:笔记（a b c-${shortHash('c0', 32)}）`)

    assert.equal(buildConflictCopy(conflict({ kind: 'prompt', key: 'other:name' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'prompt', key: 'prompt:' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'prompt', key: 'prompt:a/b' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'prompt', key: 'prompt:a\\b' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'prompt', key: 'prompt:a\u0000b' })), null)

    const skill = buildConflictCopy(
      conflict({ kind: 'skill', key: 'skill:my-skill', remoteDeviceName: 'Mac Book', remotePayload: 'SK', remoteModifiedAt: 222 })
    )
    assert.deepEqual(skill, {
      key: `skill:my-skill-from-Mac-Book-${shortHash('c0', 32)}`,
      kind: 'skill',
      payload: 'SK',
      modifiedAt: 222
    })

    const skillId = 'device-77'
    const skillFallback = buildConflictCopy(
      conflict({ id: skillId, kind: 'skill', key: 'skill:no-name', remoteDeviceName: '电脑' })
    )
    assert.equal(skillFallback.key, `skill:no-name-from-device-${shortHash(skillId, 6)}-${shortHash(skillId, 32)}`)

    assert.equal(buildConflictCopy(conflict({ kind: 'skill', key: 'skill:has space' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'skill', key: 'skill:中文' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'skill', key: 'skill:' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'skill', key: 'other:name' })), null)

    const bookmarkId = 'bookmark-conflict-1'
    const bookmarkKey = 'bookmark:note'
    const bookmark = buildConflictCopy(
      conflict({
        id: bookmarkId,
        kind: 'bookmark',
        remoteDeviceName: '我的电脑',
        remotePayload: JSON.stringify({ session: 's1', key: bookmarkKey, value: 'V' }),
        remoteModifiedAt: 333
      })
    )
    assert.deepEqual(bookmark, {
      key: `bookmark:${shortHash(`${bookmarkId}\u0000${bookmarkKey}`, 32)}`,
      kind: 'bookmark',
      payload: canonicalJson({ session: 's1', key: `bookmark:note（我的电脑-${shortHash(bookmarkId, 32)}）`, value: 'V' }),
      modifiedAt: 333
    })

    assert.equal(buildConflictCopy(conflict({ kind: 'bookmark', remotePayload: 'not json' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'bookmark', remotePayload: '"string"' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'bookmark', remotePayload: JSON.stringify({ key: 'bookmark:a', value: 'v' }) })), null)
    assert.equal(
      buildConflictCopy(conflict({ kind: 'bookmark', remotePayload: JSON.stringify({ session: 's', key: 'note', value: 'v' }) })),
      null
    )
    assert.equal(
      buildConflictCopy(conflict({ kind: 'bookmark', remotePayload: JSON.stringify({ session: 's', key: 'bookmark:a', value: 5 }) })),
      null
    )

    const scheduleId = 'sched-1'
    const scheduleConflictId = 'conflict-9'
    const scheduleNextId = `${scheduleId}-conflict-${shortHash(scheduleConflictId, 32)}`
    const schedule = buildConflictCopy(
      conflict({
        id: scheduleConflictId,
        kind: 'schedule',
        remoteDeviceName: 'MacBook-Pro',
        remotePayload: JSON.stringify({ id: scheduleId, name: '每日构建', cron: '0 9 * * *' }),
        remoteModifiedAt: 444
      })
    )
    assert.deepEqual(schedule, {
      key: `schedule:${scheduleNextId}`,
      kind: 'schedule',
      payload: canonicalJson({ id: scheduleNextId, name: `每日构建（MacBook-Pro-${shortHash(scheduleConflictId, 32)}）`, cron: '0 9 * * *' }),
      modifiedAt: 444
    })

    const scheduleNoName = buildConflictCopy(
      conflict({ id: scheduleConflictId, kind: 'schedule', remotePayload: JSON.stringify({ id: scheduleId }) })
    )
    assert.equal(scheduleNoName.key, `schedule:${scheduleNextId}`)
    assert.deepEqual(JSON.parse(scheduleNoName.payload), { id: scheduleNextId })
    assert.equal(Object.hasOwn(JSON.parse(scheduleNoName.payload), 'name'), false)

    assert.equal(buildConflictCopy(conflict({ kind: 'schedule', remotePayload: 'not json' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'schedule', remotePayload: JSON.stringify([{ id: scheduleId }]) })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'schedule', remotePayload: JSON.stringify({ name: '无 id' }) })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'schedule', remotePayload: JSON.stringify({ id: 'has space' }) })), null)
    assert.equal(
      buildConflictCopy(conflict({ kind: 'schedule', remotePayload: JSON.stringify({ id: scheduleId, name: '' }) })).key,
      `schedule:${scheduleId}-conflict-${shortHash('c0', 32)}`
    )

    assert.equal(buildConflictCopy(conflict({ kind: 'settings' })), null)
    assert.equal(buildConflictCopy(conflict({ kind: 'unknown' })), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
  console.log('sync-resolve: 全部通过')
}
