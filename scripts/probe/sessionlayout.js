/**
 * 项目—会话归属（Phase 2）。
 *
 * 这条探针不依赖 pi 是否能连上模型，只验证真实应用的 IPC 链路：
 *   listSessions → session-layout.json 迁移/投影
 *   moveSession → 只改变 Yan 的产品归属，不移动物理 JSONL
 *   再移回全局 → moveHistory 与路径保持可追溯
 */
;(async () => {
  const out = []
  const ok = (condition, text) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text)
    return !!condition
  }
  const skip = (text) => out.push('  ⤺ 跳过：' + text)

  try {
    if (typeof window.yan?.listSessions !== 'function' || typeof window.yan?.moveSession !== 'function') {
      return '  ✗ bridge 没有 listSessions/moveSession（请确认 preload 与 build 来自同一版本）'
    }

    const beforeSettings = window.__yanStore?.getState()?.settings
    const before = await window.yan.listSessions()
    out.push('=== 1. 会话索引投影 ===')
    out.push('  会话数: ' + before.length)
    if (!ok(before.length > 0, '真实 IPC 能读取隔离 fixture 会话')) return out.join('\n')

    const root = beforeSettings?.cwd ?? ''
    const target = before.find((item) => item.cwd && item.cwd !== root) ?? before[0]
    const originalPath = target.path
    const stamp = Date.now()
    const targetProjectId = 'probe-session-layout-project'
    const projects = (beforeSettings?.projects ?? []).filter((project) => project.id !== targetProjectId)
    const project = {
      id: targetProjectId,
      cwd: target.cwd,
      name: 'Live 归属探针',
      archived: false,
      createdAt: stamp,
      updatedAt: stamp
    }

    out.push('  目标: ' + target.id + '  cwd=' + target.cwd)
    const patched = await window.yan.patchSettings({ projects: [...projects, project] })
    ok(patched.projects.some((item) => item.id === targetProjectId), '隔离设置写入一个目标项目')

    out.push('')
    out.push('=== 2. 移入项目（不搬 JSONL） ===')
    const moved = await window.yan.moveSession(target.id, targetProjectId)
    ok(moved.ok, 'moveSession 返回成功')
    ok(moved.entry?.scope === 'project', '索引归属变为 project')
    ok(moved.entry?.projectId === targetProjectId, '索引记录了目标 projectId')
    ok(moved.entry?.sessionFile === originalPath, 'moveSession 保持原物理 sessionFile')

    const afterMove = await window.yan.listSessions()
    const projected = afterMove.find((item) => item.id === target.id)
    ok(projected?.scope === 'project', '重新 listSessions 后仍投影为项目会话')
    ok(projected?.projectId === targetProjectId, '重新 listSessions 后保留项目归属')
    ok(projected?.path === originalPath, '重新 listSessions 后 JSONL 路径未改变')

    out.push('')
    out.push('=== 3. 移回全局并检查历史 ===')
    const global = await window.yan.moveSession(target.id, null)
    ok(global.ok, '移回全局返回成功')
    ok(global.entry?.scope === 'global' && !global.entry?.projectId, '归属恢复为 global')
    ok(global.entry?.sessionFile === originalPath, '移回全局仍不改变物理路径')
    ok((global.entry?.moveHistory?.length ?? 0) >= 2, '项目↔全局迁移写入 moveHistory')

    if (beforeSettings) {
      // 只恢复本次探针对设置的临时项目；session-layout 会保留迁移历史，供上面的断言完成。
      await window.yan.patchSettings({ projects: beforeSettings.projects })
    } else {
      skip('没有拿到 renderer 设置快照，未恢复项目列表')
    }
  } catch (error) {
    out.push('  ✗ 抛异常：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
