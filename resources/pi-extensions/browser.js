/*
 * Yan built-in browser extension.
 *
 * The page is rendered by Electron's WebContentsView. This extension only
 * talks to the authenticated loopback bridge and receives structured state;
 * it never gets an Electron object or a general-purpose page JS primitive.
 */
const bridge = process.env.YAN_BROWSER_BRIDGE_URL
const token = process.env.YAN_BROWSER_BRIDGE_TOKEN

async function request(path, options = {}) {
  if (!bridge || !token) throw new Error('砚内置浏览器桥未启动')
  const response = await fetch(`${bridge}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), 'x-yan-browser-token': token }
  })
  const payload = await response.json()
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `浏览器操作失败 (${response.status})`)
    error.code = payload.code
    throw error
  }
  return payload
}

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function textResult(text, details = {}) {
  return { content: [{ type: 'text', text }], details }
}

function observationResult(observation) {
  const elements = observation.elements.map((element) => {
    const flags = [element.disabled ? ' disabled' : '', element.value ? ` value=${JSON.stringify(element.value)}` : ''].join('')
    return `${element.ref} ${element.role} ${JSON.stringify(element.name)} box=${JSON.stringify(element.box)}${flags}`
  }).join('\n')
  return textResult(
    `URL: ${observation.url}\nTitle: ${observation.title}\nGeneration: ${observation.generationId}\n` +
      `Accessibility nodes: ${observation.accessibilityNodeCount}\n\nInteractive elements:\n${elements || '(none)'}\n\n${observation.text}`,
    observation
  )
}

export default function (pi) {
  pi.registerTool({
    name: 'browser_open', label: 'Browser open',
    description: 'Open an http(s) URL in Yan built-in browser.',
    parameters: schema({ url: { type: 'string' } }, ['url']),
    async execute(_id, params) {
      const state = await request('/navigate', { method: 'POST', body: JSON.stringify({ url: params.url }) })
      return textResult(`Opened ${state.url || params.url}`, state)
    }
  })

  // Compatibility alias for sessions that already contain browser_navigate calls.
  pi.registerTool({
    name: 'browser_navigate', label: 'Browser navigate',
    description: 'Compatibility alias for browser_open.',
    parameters: schema({ url: { type: 'string' } }, ['url']),
    async execute(_id, params) {
      const state = await request('/navigate', { method: 'POST', body: JSON.stringify({ url: params.url }) })
      return textResult(`Opened ${state.url || params.url}`, state)
    }
  })

  /*
   * 接入本机已安装的 Chrome（独立 profile + CDP）。
   * 用于需要**登录态**的站点（例如 ChatGPT 网页版）：内嵌视图是隔离的、
   * 没有用户 cookie，这里让用户在弹出的真实 Chrome 窗口里登录一次。
   */
  pi.registerTool({
    name: 'browser_connect_local_chrome', label: 'Browser connect local Chrome',
    description: 'Connect to the locally installed Chrome and drive it over CDP. Use this when a task needs the user\'s login session on a site (e.g. ChatGPT web). An isolated profile is used, so the user may need to sign in once in the opened window.',
    parameters: schema({ url: { type: 'string' } }),
    async execute(_id, params) {
      const payload = await request('/external/open', {
        method: 'POST',
        body: JSON.stringify({ url: params.url || 'https://chatgpt.com' })
      })
      return textResult('Connected to the locally installed Chrome. Ask the user to finish signing in there, then continue with browser_observe.', payload)
    }
  })

  pi.registerTool({
    name: 'browser_disconnect_local_chrome', label: 'Browser disconnect local Chrome',
    description: 'Disconnect from the locally installed Chrome and close the process this app launched.',
    parameters: schema({}),
    async execute() {
      return textResult('Disconnected from the locally installed Chrome.', await request('/external/close', { method: 'POST' }))
    }
  })

  pi.registerTool({
    name: 'browser_observe', label: 'Browser observe',
    description: 'Observe the current page with URL, title, visible text, accessibility metadata, and generation-scoped element refs.',
    parameters: schema({}),
    async execute() { return observationResult(await request('/observe')) }
  })

  pi.registerTool({
    name: 'browser_click', label: 'Browser click',
    description: 'Click an element by a ref returned by browser_observe. Re-observe after STALE_ELEMENT.',
    parameters: schema({ ref: { type: 'string' } }, ['ref']),
    async execute(_id, params) {
      const payload = await request('/click', { method: 'POST', body: JSON.stringify({ ref: params.ref }) })
      return payload.observation ? observationResult(payload.observation) : textResult('Clicked the requested page element.', payload)
    }
  })

  pi.registerTool({
    name: 'browser_type', label: 'Browser type',
    description: 'Type text into an element by a ref returned by browser_observe.',
    parameters: schema({ ref: { type: 'string' }, text: { type: 'string' } }, ['ref', 'text']),
    async execute(_id, params) {
      const payload = await request('/type', { method: 'POST', body: JSON.stringify({ ref: params.ref, text: params.text }) })
      return payload.observation ? observationResult(payload.observation) : textResult('Filled the requested page element.', payload)
    }
  })

  pi.registerTool({
    name: 'browser_press', label: 'Browser press',
    description: 'Dispatch a keyboard key such as Enter, Tab, Escape, or ArrowDown.',
    parameters: schema({ key: { type: 'string' } }, ['key']),
    async execute(_id, params) {
      const payload = await request('/press', { method: 'POST', body: JSON.stringify({ key: params.key }) })
      return payload.observation ? observationResult(payload.observation) : textResult('Pressed the requested key.', payload)
    }
  })

  pi.registerTool({
    name: 'browser_scroll', label: 'Browser scroll',
    description: 'Scroll the current page using mouse-wheel deltas.',
    parameters: schema({ deltaY: { type: 'number' }, deltaX: { type: 'number' } }, ['deltaY']),
    async execute(_id, params) {
      const payload = await request('/scroll', { method: 'POST', body: JSON.stringify({ deltaX: params.deltaX || 0, deltaY: params.deltaY }) })
      return payload.observation ? observationResult(payload.observation) : textResult('Scrolled the page.', payload)
    }
  })

  for (const [name, path, label] of [['browser_back', '/back', 'Browser back'], ['browser_reload', '/reload', 'Browser reload']]) {
    pi.registerTool({
      name, label, description: `Run ${name} in Yan built-in browser.`, parameters: schema({}),
      async execute() { return textResult(`${name} completed.`, await request(path, { method: 'POST' })) }
    })
  }

  pi.registerTool({
    name: 'browser_new_tab', label: 'Browser new tab', description: 'Open a new browser tab in the shared persistent session.',
    parameters: schema({ url: { type: 'string' } }, ['url']),
    async execute(_id, params) { return textResult('Opened a new browser tab.', await request('/new-tab', { method: 'POST', body: JSON.stringify({ url: params.url }) })) }
  })

  pi.registerTool({
    name: 'browser_switch_tab', label: 'Browser switch tab', description: 'Switch to a tab id returned by browser state.',
    parameters: schema({ id: { type: 'string' } }, ['id']),
    async execute(_id, params) { return textResult('Switched browser tab.', await request('/switch-tab', { method: 'POST', body: JSON.stringify({ id: params.id }) })) }
  })

  pi.registerTool({
    name: 'browser_screenshot', label: 'Browser screenshot', description: 'Capture a screenshot of the current browser tab.',
    parameters: schema({}),
    async execute() {
      const image = await request('/screenshot')
      return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }, { type: 'text', text: 'Screenshot captured.' }], details: {} }
    }
  })

  pi.registerTool({
    name: 'browser_download', label: 'Browser download', description: 'Return the most recently completed controlled browser download.',
    parameters: schema({}),
    async execute() {
      const state = await request('/state')
      return textResult(state.lastDownload ? `Downloaded ${state.lastDownload.filename} to ${state.lastDownload.path}` : 'No completed browser download yet.', state.lastDownload || {})
    }
  })

  pi.registerTool({
    name: 'browser_request_user_control', label: 'Browser user control',
    description: 'Pause agent browser actions so the user can handle passwords, CAPTCHA, passkeys, payment, or other sensitive steps.',
    parameters: schema({ reason: { type: 'string' } }),
    async execute(_id, params) {
      const state = await request('/request-user-control', { method: 'POST', body: JSON.stringify({ reason: params.reason }) })
      return textResult('User control requested. Ask the user to operate the browser, then resume when finished.', state)
    }
  })

  pi.registerCommand('browser', {
    description: 'Show browser status, or open a URL.',
    handler: async (args, ctx) => {
      const value = String(args || '').trim()
      const state = value ? await request('/navigate', { method: 'POST', body: JSON.stringify({ url: value }) }) : await request('/state')
      ctx.ui.notify(state.url ? `Browser: ${state.url}` : 'Browser is closed', 'info')
    }
  })
}

