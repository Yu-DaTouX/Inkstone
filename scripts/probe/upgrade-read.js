;(async () => {
  const out = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  for (let i = 0; i < 80 && !store; i += 1) await sleep(250)

  const summary = { ok: false }

  try {
    let conn = store?.getState?.().conn ?? null
    for (let i = 0; i < 60 && conn !== 'ready'; i += 1) {
      await sleep(500)
      conn = store?.getState?.().conn ?? conn
    }
    summary.conn = conn

    const settings = await window.yan.getSettings().catch(() => null)
    summary.settings = settings
      ? {
          cwd: settings.cwd ?? null,
          lang: settings.lang ?? null,
          theme: settings.theme ?? null,
          projects: Array.isArray(settings.projects) ? settings.projects.length : null,
          profile: settings.profile
            ? { name: settings.profile.name ?? null, signedIn: settings.profile.signedIn === true, avatarValue: settings.profile.avatarValue ?? null }
            : null
        }
      : null

    const auth = await window.yan.authFileInfo().catch(() => null)
    summary.auth = auth ? { exists: auth.exists === true, count: auth.count ?? 0 } : null

    const info = await window.yan.piInfo().catch(() => null)
    summary.pi = info ? { version: info.version ?? null, bundled: /pi-runtime[\\/]dist[\\/]bundle[\\/]cli\.js$/i.test(String(info.bin ?? '')) } : null

    let rawTheme = null
    let rawOnboarded = null
    try {
      rawTheme = window.localStorage.getItem('yan.theme')
      rawOnboarded = window.localStorage.getItem('yan.onboarded')
    } catch {
    }
    summary.local = { theme: rawTheme, onboarded: rawOnboarded }

    summary.ok = summary.conn === 'ready' && !!summary.settings
  } catch (error) {
    summary.error = error?.message ?? String(error)
  }

  out.push('UPGRADE-READ ' + JSON.stringify(summary))
  return out.join('\n')
})()
