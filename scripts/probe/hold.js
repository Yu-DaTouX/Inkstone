;(async () => {
  await new Promise((r) => setTimeout(r, Number(window.__holdMs) || 90000))
  return '=== hold 结束 ==='
})()
