export function claudeQuotaFixture(now = Date.now()) {
  const weeklyReset = new Date(now + 3 * 86_400_000).toISOString()
  return {
    five_hour: { utilization: 77, resets_at: new Date(now + 3_600_000).toISOString() },
    seven_day: { utilization: 88, resets_at: weeklyReset },
    limits: [{ kind: 'weekly_scoped', group: 'model', percent: 99, resets_at: weeklyReset, severity: 'warning', is_active: true, scope: { model: { display_name: 'Fable' } } }],
    cedar_ember: {
      eligible: true,
      next_grant_id: 'normal-grant',
      grants: [
        { id: 'normal-grant', resets_left: 2, type: 'full', clears: ['five_hour', 'seven_day'], usable_now: true, ends_at: new Date(now + 5 * 86_400_000).toISOString() },
        { id: 'fable-grant', resets_left: 1, gives_back_weekly: true, clears: ['seven_day_overage_included'], usable_now: true, ends_at: new Date(now + 2 * 86_400_000).toISOString() }
      ]
    }
  }
}
