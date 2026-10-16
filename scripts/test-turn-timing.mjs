export async function runTurnTimingTests(ok) {
  const { turnTiming } = await import('../out/test/turn-timing.mjs')
  const { groupIntoTurns } = await import('../out/test/turns.mjs')

  const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

  console.log('\n--- 11.7 回合计时：整轮 vs 生成速度 ---')

  {
    const r = turnTiming({
      usage: { output: 100 },
      firstTokenAt: 8000,
      startedAt: 8000,
      turnStartedAt: 0,
      endedAt: 10000
    })
    ok(r.elapsedMs === 10000, '整轮用时从 agent 回合起点算（含工具 8s）', `实际 ${r.elapsedMs}`)
    ok(near(r.speed, 50), '生成速度只看首 token 之后那 2 秒（100tok/2s=50）', `实际 ${r.speed}`)
    ok(
      !near(r.speed, 12.5),
      '速度没有把工具等待摊进去（若用回合起点会得到 12.5，属于回归）',
      `实际 ${r.speed}`
    )
  }

  {
    const r = turnTiming({ usage: { output: 40 }, startedAt: 5000, turnStartedAt: 1000, endedAt: 9000 })
    ok(near(r.speed, 10), '没有首 token 时速度退回本条消息流起点（40tok/4s=10）', `实际 ${r.speed}`)
    ok(r.elapsedMs === 8000, '整轮仍按回合起点算', `实际 ${r.elapsedMs}`)
  }

  {
    const noUsage = turnTiming({ turnStartedAt: 0, startedAt: 0, endedAt: 4000 })
    ok(noUsage.speed === undefined, '没有 usage 时不产生速度', `实际 ${noUsage.speed}`)
    ok(noUsage.elapsedMs === 4000, '没有 usage 时整轮用时照常给出（provider 不报 token 也能显示）')

    const zeroOut = turnTiming({ usage: { output: 0 }, firstTokenAt: 0, turnStartedAt: 0, endedAt: 3000 })
    ok(zeroOut.speed === undefined, 'usage.output=0 时同样不给速度（不拿 0 当速率）', `实际 ${zeroOut.speed}`)
    ok(zeroOut.elapsedMs === 3000, 'output=0 不影响整轮用时')
  }

  {
    const r = turnTiming({ usage: { output: 10 }, endedAt: 7000 })
    ok(r.elapsedMs === undefined, '既无回合起点又无流起点时不产生用时（不假装）', `实际 ${r.elapsedMs}`)
    ok(r.speed === undefined, '两种起点都没有时也不产生速度')
  }

  {
    const r = turnTiming({ usage: { output: 10 }, firstTokenAt: 9000, turnStartedAt: 9000, endedAt: 1000 })
    ok(r.elapsedMs === 1, '结束早于起点时整轮用时钳到 1ms（不出现 0 / 负数）', `实际 ${r.elapsedMs}`)
    ok(r.speed === 10 / 0.001, '速度同样以 1ms 为下限', `实际 ${r.speed}`)
  }

  {
    const first = turnTiming({ usage: { output: 0 }, firstTokenAt: 3000, startedAt: 100, turnStartedAt: 0, endedAt: 3500 })
    const afterRetry = turnTiming({ usage: { output: 200 }, firstTokenAt: 6000, startedAt: 5000, turnStartedAt: 0, endedAt: 9000 })
    ok(afterRetry.elapsedMs > first.elapsedMs, '重试后的整轮用时大于上一次尝试的时点', `${first.elapsedMs} → ${afterRetry.elapsedMs}`)
    ok(afterRetry.elapsedMs === 9000, '重试等待留在整轮里（9000ms）')
  }

  {
    const asst = (id, extra) => ({ id, role: 'assistant', text: `回复 ${id}`, ...extra })
    const turns = groupIntoTurns([
      { id: 'u1', role: 'user', text: '跑一下' },
      asst('a1', { toolCalls: [{ id: 't1', name: 'bash', args: {}, status: 'ok' }], elapsedMs: 4200 }),
      asst('a2', { toolCalls: [{ id: 't2', name: 'read', args: {}, status: 'ok' }], elapsedMs: 9100 }),
      asst('a3', { elapsedMs: 13800 })
    ])
    const a = turns[1]
    ok(a?.kind === 'assistant', '三块合成一个助手回合')
    ok(a.elapsedMs === 13800, '回合用时取最后一条（= 整轮，不是某一条的生成时间）', `实际 ${a.elapsedMs}`)
  }

  {
    const turns = groupIntoTurns([
      { id: 'r-u1', role: 'user', text: '跑一下', timestamp: 1 },
      { id: 'r-a1', role: 'assistant', text: '第一条', timestamp: 2 },
      {
        id: 'r-a2',
        role: 'assistant',
        text: '第二条',
        timestamp: 3,
        turnTiming: {
          logicalTurnId: 'r-a1',
          startedAt: 1000,
          endedAt: 51000,
          elapsedMs: 50000,
          terminalReason: 'completed'
        }
      }
    ])
    const t = turns.find((x) => x.kind === 'assistant')
    ok(t?.elapsedMs === 50000, '重载后从宿主元数据恢复整轮用时', `实际 ${t?.elapsedMs}`)
    ok(t?.timingRecorded === true, '标记「这一轮有记录」')
    ok(t?.terminalReason === 'completed', '终止原因跟着恢复', t?.terminalReason)
  }

  {
    const turns = groupIntoTurns([
      { id: 'o-u1', role: 'user', text: '旧会话', timestamp: 1 },
      { id: 'o-a1', role: 'assistant', text: '回答', timestamp: 2 }
    ])
    const t = turns.find((x) => x.kind === 'assistant')
    ok(t?.elapsedMs === undefined, '旧历史没有用时就是没有（不拿时间戳差冒充）')
    ok(t?.timingRecorded !== true, '旧历史不标记为「有记录」（界面据此说未记录）')
  }

  {
    const turns = groupIntoTurns([
      { id: 'p-u1', role: 'user', text: 'x', timestamp: 1 },
      {
        id: 'p-a1',
        role: 'assistant',
        text: 'y',
        timestamp: 2,
        elapsedMs: 1234,
        turnTiming: {
          logicalTurnId: 'p-a1',
          startedAt: 1,
          endedAt: 2,
          elapsedMs: 9999,
          terminalReason: 'stopped'
        }
      }
    ])
    const t = turns.find((x) => x.kind === 'assistant')
    ok(t?.elapsedMs === 1234, '推送来的本轮用时优先于日志值', `实际 ${t?.elapsedMs}`)
    ok(t?.terminalReason === 'stopped', '终止原因仍取日志（推送不带它）', t?.terminalReason)
  }
}
