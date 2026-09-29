/* 只等着：给外部工具（CDP 采样等）留出时间，不做任何断言。 */
;(async () => {
  await new Promise((r) => setTimeout(r, Number(window.__holdMs) || 90000))
  return '=== hold 结束 ==='
})()
