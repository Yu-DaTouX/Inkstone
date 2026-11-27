function yanObserve(attr, frameKey, limit) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const selector = 'a[href],button,input:not([type=hidden]),textarea,select,summary,form,dialog,[contenteditable=""],[contenteditable="true"],[role],[tabindex]:not([tabindex="-1"]),[onclick]'
  const roles = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider', 'spinbutton', 'treeitem', 'form', 'dialog', 'alertdialog', 'search', 'gridcell', 'row'])
  const inputRole = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button' }
  const roleOf = (el) => {
    const explicit = clean(el.getAttribute('role')).split(' ')[0]
    if (explicit) return roles.has(explicit) ? explicit : ''
    const tag = el.tagName
    if (tag === 'A') return 'link'
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button'
    if (tag === 'INPUT') return inputRole[(el.type || 'text').toLowerCase()] ?? 'textbox'
    if (tag === 'TEXTAREA') return 'textbox'
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'FORM') return 'form'
    if (tag === 'DIALOG') return el.open ? 'dialog' : ''
    if (el.isContentEditable) return 'textbox'
    return 'button'
  }
  const nameOf = (el) => {
    const aria = clean(el.getAttribute('aria-label'))
    if (aria) return aria
    const labelled = clean(el.getAttribute('aria-labelledby')).split(' ').filter(Boolean).map((id) => document.getElementById(id)?.innerText ?? '').join(' ')
    if (clean(labelled)) return clean(labelled)
    if (el.labels && el.labels.length) {
      const text = clean([...el.labels].map((label) => label.innerText).join(' '))
      if (text) return text
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) return clean(el.value)
    if (!['INPUT', 'TEXTAREA', 'SELECT', 'FORM'].includes(el.tagName) && !el.isContentEditable) {
      const inner = clean(el.innerText || el.textContent)
      if (inner) return inner.slice(0, 160)
      const img = el.querySelector('img[alt]')
      if (img && clean(img.alt)) return clean(img.alt)
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').slice(0, 160)
  }
  const secret = (el) => (el.type || '').toLowerCase() === 'password' || /cc-|one-time-code|current-password|new-password/i.test(el.getAttribute('autocomplete') || '')
  const valueOf = (el) => {
    if (el.tagName === 'INPUT') {
      const type = (el.type || '').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked'
      if (['button', 'submit', 'reset', 'image', 'file'].includes(type)) return undefined
      if (secret(el)) return el.value ? '\u2022\u2022\u2022\u2022' : ''
      return el.value
    }
    if (el.tagName === 'TEXTAREA') return el.value
    if (el.tagName === 'SELECT') return [...el.selectedOptions].map((option) => clean(option.label || option.text)).join(', ')
    if (el.isContentEditable) return clean(el.innerText).slice(0, 500)
    const checked = el.getAttribute('aria-checked')
    if (checked === 'true' || checked === 'false') return checked === 'true' ? 'checked' : 'unchecked'
    return undefined
  }
  const hrefOf = (el) => {
    if (el.tagName !== 'A' || !el.href) return undefined
    try {
      const url = new URL(el.href)
      url.username = ''
      url.password = ''
      return url.href
    } catch {
      return undefined
    }
  }
  const pattern = new RegExp(`^${frameKey}\\d+$`)
  const width = innerWidth
  const height = innerHeight
  const elements = []
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= limit) break
    const role = roleOf(el)
    if (!role) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    let ref = el.getAttribute(attr)
    if (!ref || !pattern.test(ref)) {
      globalThis.__yanRefSeq = (globalThis.__yanRefSeq || 0) + 1
      ref = `${frameKey}${globalThis.__yanRefSeq}`
      el.setAttribute(attr, ref)
    }
    const value = valueOf(el)
    const href = hrefOf(el)
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    elements.push({
      ref,
      role,
      name: nameOf(el),
      box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      ...(value !== undefined ? { value: String(value).slice(0, 500) } : {}),
      ...(href ? { href } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width ? { offscreen: true } : {})
    })
  }
  return {
    url: location.href,
    title: document.title,
    text: window === top ? String(document.body?.innerText ?? '').slice(0, 200000) : '',
    elements,
    viewport: { width, height }
  }
}

function yanFrameOffsets() {
  return [...document.querySelectorAll('iframe,frame')].map((frame) => {
    const rect = frame.getBoundingClientRect()
    const style = getComputedStyle(frame)
    return {
      src: frame.src || '',
      x: rect.x + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0),
      y: rect.y + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0)
    }
  })
}

function yanScope(attr, ref) {
  const root = document.querySelector(`[${attr}="${ref}"]`)
  if (!root) return null
  return [ref, ...[...root.querySelectorAll(`[${attr}]`)].map((el) => el.getAttribute(attr))]
}

function yanPoint(attr, ref) {
  const el = document.querySelector(`[${attr}="${ref}"]`)
  if (!el) return { error: 'stale' }
  const before = el.getBoundingClientRect()
  if (before.top < 0 || before.bottom > innerHeight || before.left < 0 || before.right > innerWidth) el.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = el.getBoundingClientRect()
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  const hit = document.elementFromPoint(x, y)
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    const label = hit.closest('label')
    if (!(label && (label.control === el || label.contains(el)))) {
      const desc = `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}${typeof hit.className === 'string' && hit.className.trim() ? `.${hit.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`
      return { x, y, obscuredBy: desc }
    }
  }
  return { x, y }
}

function yanClick(attr, ref) {
  const el = document.querySelector(`[${attr}="${ref}"]`)
  if (!el) return { error: 'stale' }
  const rect = el.getBoundingClientRect()
  const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
  setTimeout(() => {
    if (typeof el.focus === 'function') el.focus({ preventScroll: true })
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mousedown', init))
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mouseup', init))
    el.click()
  }, 0)
  return { ok: true }
}

function yanFocus(attr, ref) {
  const el = document.querySelector(`[${attr}="${ref}"]`)
  if (!el) return { error: 'stale' }
  el.focus({ preventScroll: true })
  if (el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  } else if (typeof el.select === 'function') {
    try { el.select() } catch {}
  }
  return { ok: true }
}

function yanType(attr, ref, text) {
  const el = document.querySelector(`[${attr}="${ref}"]`)
  if (!el) return { error: 'stale' }
  const tag = el.tagName
  if (!el.isContentEditable && tag !== 'INPUT' && tag !== 'TEXTAREA') return { error: 'not_editable', tag: tag.toLowerCase() }
  el.focus({ preventScroll: true })
  const secret = (el.type || '').toLowerCase() === 'password' || /cc-|one-time-code|current-password|new-password/i.test(el.getAttribute('autocomplete') || '')
  const direct = tag === 'INPUT' && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes((el.type || '').toLowerCase())
  if (direct) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: secret ? (el.value ? '\u2022\u2022\u2022\u2022' : '') : el.value }
  }
  if (el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  } else {
    try { el.select() } catch {}
  }
  let done = false
  try { done = text ? document.execCommand('insertText', false, text) : document.execCommand('delete', false) } catch {}
  const current = () => (el.isContentEditable ? el.innerText : el.value)
  if (!done || (text && !String(current()).includes(text))) {
    if (el.isContentEditable) el.textContent = text
    else {
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
  }
  el.dispatchEvent(new Event('change', { bubbles: true }))
  const value = current()
  return { ok: true, value: secret ? (value ? '\u2022\u2022\u2022\u2022' : '') : String(value).slice(0, 500) }
}

function yanSelect(attr, ref, wanted) {
  const el = document.querySelector(`[${attr}="${ref}"]`)
  if (!el) return { error: 'stale' }
  if (el.tagName !== 'SELECT') return { error: 'not_select', tag: el.tagName.toLowerCase() }
  const options = [...el.options]
  const target = options.find((option) => option.value === wanted) ?? options.find((option) => option.label.trim() === wanted.trim() || option.text.trim() === wanted.trim())
  if (!target) return { error: 'option_not_found', options: options.map((option) => option.label || option.text).slice(0, 50) }
  el.focus({ preventScroll: true })
  el.value = target.value
  target.selected = true
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, value: target.value, label: target.label || target.text }
}

function yanPress(chord, force) {
  const parts = String(chord).split('+').map((part) => part.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const mods = new Set(parts.map((part) => part.toLowerCase()))
  const ctrl = mods.has('control') || mods.has('ctrl') || mods.has('controlormeta') || mods.has('meta') || mods.has('cmd')
  const shift = mods.has('shift')
  const alt = mods.has('alt')
  if (!force && !document.hasFocus()) return { skipped: true }
  let target = document.activeElement || document.body
  if (!force && (target.tagName === 'IFRAME' || target.tagName === 'FRAME')) return { skipped: true }
  while (target && target.shadowRoot && target.shadowRoot.activeElement) target = target.shadowRoot.activeElement
  const init = { key, bubbles: true, cancelable: true, composed: true, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: mods.has('meta') || mods.has('cmd') }
  const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init))
  const editable = target.isContentEditable || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((target.type || '').toLowerCase()))
  if (proceed) {
    if (key.length === 1 && !ctrl && !alt) {
      target.dispatchEvent(new KeyboardEvent('keypress', init))
      if (editable) document.execCommand('insertText', false, key)
    } else if (ctrl && key.toLowerCase() === 'a') {
      if (typeof target.select === 'function') target.select()
      else document.execCommand('selectAll')
    } else if (key === 'Enter') {
      if (target.tagName === 'TEXTAREA' || target.isContentEditable) document.execCommand(shift ? 'insertLineBreak' : 'insertParagraph')
      else if (target.tagName === 'INPUT' && target.form) {
        if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit()
        else target.form.submit()
      } else if (target.tagName === 'A' || target.tagName === 'BUTTON' || target.getAttribute?.('role') === 'button') target.click()
    } else if (key === ' ' || key === 'Space') {
      if (['BUTTON', 'SUMMARY'].includes(target.tagName) || ['checkbox', 'radio'].includes((target.type || '').toLowerCase())) target.click()
    } else if (key === 'Tab') {
      const focusable = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')].filter((el) => !el.disabled && el.getClientRects().length)
      const index = focusable.indexOf(target)
      const next = focusable[(index + (shift ? -1 : 1) + focusable.length) % focusable.length]
      next?.focus()
    } else if (key === 'Backspace' && editable) document.execCommand('delete')
    else if (key === 'Delete' && editable) document.execCommand('forwardDelete')
    else if (!editable && ['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp'].includes(key)) {
      const step = { PageDown: innerHeight * 0.9, PageUp: -innerHeight * 0.9, ArrowDown: 40, ArrowUp: -40 }[key]
      if (key === 'Home') scrollTo(scrollX, 0)
      else if (key === 'End') scrollTo(scrollX, document.documentElement.scrollHeight)
      else scrollBy(0, step)
    }
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  return { ok: true }
}

function yanScroll(dx, dy) {
  scrollBy(dx, dy)
  return { x: Math.round(scrollX), y: Math.round(scrollY), maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)) }
}

function yanReadValue(attr, ref) {
  const el = document.querySelector(`[${attr}="${ref}"]`)
  if (!el) return null
  const secret = (el.type || '').toLowerCase() === 'password' || /cc-|one-time-code|current-password|new-password/i.test(el.getAttribute('autocomplete') || '')
  if (secret) {
    const raw = el.isContentEditable ? el.innerText : el.value
    return raw ? '\u2022\u2022\u2022\u2022' : ''
  }
  return el.isContentEditable ? String(el.innerText).slice(0, 500) : typeof el.value === 'string' ? el.value.slice(0, 500) : null
}

function yanText() {
  return { text: String(document.body?.innerText ?? ''), url: location.href, title: document.title }
}

function yanVisibility() {
  return document.visibilityState
}

function yanCursor(label, point, tap, style, markup, kinds) {
  const key = '__inkstoneAgentCursor'
  let state = globalThis[key]
  const finish = (target) => {
    clearTimeout(target.timer)
    clearTimeout(target.pressTimer)
    target.host.remove()
    if (globalThis[key] === target) delete globalThis[key]
  }
  if (!label) {
    if (state) finish(state)
    return 0
  }
  let fresh = false
  if (!state || !state.host.isConnected) {
    const host = document.createElement('div')
    host.setAttribute('data-inkstone-agent-cursor', '')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;background:transparent!important;pointer-events:none!important;z-index:2147483647!important'
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = '<style>' + style + '</style>' + markup
    document.documentElement.appendChild(host)
    try { host.setAttribute('popover', 'manual'); host.showPopover() } catch {}
    state = { host, cursor: root.querySelector('.cursor'), badge: root.querySelector('.badge'), ripple: root.querySelector('.ripple'), x: 24, y: 24 }
    globalThis[key] = state
    fresh = true
  }
  const moved = !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
  let distance = 0
  if (moved) {
    const x = Math.max(0, Math.min(innerWidth - 1, point.x))
    const y = Math.max(0, Math.min(innerHeight - 1, point.y))
    distance = Math.hypot(x - state.x, y - state.y)
    state.x = x
    state.y = y
  }
  const duration = fresh ? 0 : Math.round(Math.min(420, 160 + distance * 0.35))
  state.cursor.style.transitionDuration = duration + 'ms,180ms'
  state.cursor.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)'
  for (const name of kinds) state.cursor.classList.toggle('k-' + name, name === label)
  state.badge.classList.toggle('left', state.x > innerWidth - 80)
  state.badge.classList.toggle('up', state.y > innerHeight - 60)
  if (fresh) void state.cursor.offsetWidth
  state.cursor.classList.add('on')
  clearTimeout(state.pressTimer)
  state.cursor.classList.remove('press')
  const current = state
  if (moved && tap) {
    current.pressTimer = setTimeout(() => {
      current.cursor.classList.add('press')
      current.ripple.classList.remove('go')
      void current.ripple.offsetWidth
      current.ripple.classList.add('go')
      current.pressTimer = setTimeout(() => current.cursor.classList.remove('press'), 140)
    }, duration)
  }
  clearTimeout(current.timer)
  current.timer = setTimeout(() => {
    current.cursor.classList.remove('on')
    current.timer = setTimeout(() => finish(current), 220)
  }, 2400)
  return moved ? duration : 0
}
