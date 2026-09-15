/** 能力列表响应的过期判定（用户报的「看不到模型选择」的根因之一）。 */
export function runCapabilityRequestTests(ok, mod) {
  const { isCapabilityResponseStale } = mod

  /* ---- 核心回归：sessionId 从 pending 过渡到稳定 uuid 不该判过期 ---- */
  ok(
    !isCapabilityResponseStale(
      { runnerId: 'r1', sessionId: 'pending:r1' },
      { runnerId: 'r1', sessionId: '01a0a3cb-0aaf-721c' }
    ),
    'runId 未变时，sessionId 从 pending 变稳定不算过期（这是模型菜单为空的根因）'
  )
  ok(
    !isCapabilityResponseStale(
      { runnerId: 'r1', sessionId: '01a0a3cb' },
      { runnerId: 'r1', sessionId: '01a0a3cb' }
    ),
    'runId 与 sessionId 都不变 → 不过期'
  )

  /* ---- 真正要防的：换了运行实例 ---- */
  ok(
    isCapabilityResponseStale({ runnerId: 'r1' }, { runnerId: 'r2' }),
    '切到别的运行实例 → 过期（旧响应不许覆盖新会话）'
  )
  ok(
    isCapabilityResponseStale({ runnerId: 'r1' }, { runnerId: null }),
    '实例身份消失 → 过期'
  )

  /* ---- 没有 runId 的旧路径：退回 sessionId 比较 ---- */
  ok(
    isCapabilityResponseStale({ runnerId: null, sessionId: 'a' }, { runnerId: null, sessionId: 'b' }),
    '没有 runId 时，sessionId 变了仍然判过期'
  )
  ok(
    !isCapabilityResponseStale({ runnerId: null, sessionId: 'a' }, { runnerId: null, sessionId: 'a' }),
    '没有 runId 时，sessionId 相同不过期'
  )
  ok(
    !isCapabilityResponseStale({ runnerId: null, sessionId: '' }, { runnerId: null, sessionId: 'a' }),
    '最早几帧还没有 sessionId → 不过期（要先能应用上）'
  )
  ok(
    isCapabilityResponseStale(
      { runnerId: null, sessionId: 'pending:r1' },
      { runnerId: null, sessionId: 'stable' }
    ),
    '没有 runId 时 pending→稳定 仍按 sessionId 判（旧路径保持原语义）'
  )

  /* ---- runnerId 出现后就不再受 sessionId 影响 ---- */
  ok(
    !isCapabilityResponseStale(
      { runnerId: 'r1', sessionId: undefined },
      { runnerId: 'r1', sessionId: undefined }
    ),
    '只有 runId、两边都没有 sessionId → 不过期'
  )
}
