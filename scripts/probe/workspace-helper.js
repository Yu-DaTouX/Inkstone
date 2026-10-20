;(() => {
  if (window.__yanComposer) return 'exists'

  const SELECTOR = '[data-testid="composer-input"]'

  const el = (target) => {
    if (target && target.nodeType === 1 && target.matches(SELECTOR)) return target
    return document.querySelector(SELECTOR)
  }

  const textFromView = (host) => {
    let desc = host.pmViewDesc
    while (desc && !desc.node) desc = desc.parent
    const node = desc && desc.node
    if (!node || typeof node.forEach !== 'function') return null
    return projectDoc(node)
  }

  const wrapMarks = (marks, value) => {
    let inner = value
    if (marks.some((mark) => mark.type.name === 'code')) inner = `\`${inner}\``
    if (marks.some((mark) => mark.type.name === 'strike')) inner = `~~${inner}~~`
    const link = marks.find((mark) => mark.type.name === 'link')
    const href = link ? String(link.attrs.href ?? '') : ''
    if (href && href !== value) inner = `[${inner}](${href})`
    return inner
  }

  const leafText = (node) => {
    if (node.type.name === 'command_chip') return `/${node.attrs.id}`
    if (node.type.name === 'mention') return String(node.attrs.raw)
    if (node.type.name === 'hard_break') return '\n'
    return ''
  }

  const projectDoc = (doc) => {
    const parts = []
    doc.forEach((block, _offset, index) => {
      if (index) parts.push('\n')
      if (block.type.name === 'code_block') {
        parts.push(`\`\`\`${String(block.attrs.language ?? '')}\n${block.textContent}\n\`\`\``)
        return
      }
      block.forEach((child) => parts.push(child.isText ? wrapMarks(child.marks, child.text ?? '') : leafText(child)))
    })
    return parts.join('')
  }

  const readNode = (node) => {
    if (node.nodeType === 3) return node.nodeValue || ''
    if (node.nodeType !== 1) return ''
    if (node.tagName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n'
    return [...node.childNodes].map(readNode).join('')
  }

  const textFromDom = (host) => [...host.childNodes].map(readNode).join('\n')

  const text = (target) => {
    const host = el(target)
    if (!host) return null
    const fromView = textFromView(host)
    return fromView === null ? textFromDom(host) : fromView
  }

  const escapeHtml = (value) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const inlineHtml = (value) =>
    `<p>${value.split('\n').map(escapeHtml).join('<br>')}${value.endsWith('\n') ? '<br>' : ''}</p>`

  const selectAll = (host) => {
    const range = document.createRange()
    range.selectNodeContents(host)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const focus = (target) => {
    const host = el(target)
    if (!host) return null
    host.focus()
    return host
  }

  const set = (value, target) => {
    const host = focus(target)
    if (!host) return null
    const source = String(value ?? '').replace(/\r\n?/g, '\n')
    selectAll(host)
    if (!source) document.execCommand('delete')
    else if (source.includes('\n')) document.execCommand('insertHTML', false, inlineHtml(source))
    else document.execCommand('insertText', false, source)
    return text(host)
  }

  const clear = (target) => set('', target)

  const append = (value, target) => {
    const host = el(target)
    if (!host) return null
    return set(`${text(host) ?? ''}${String(value ?? '')}`, host)
  }

  window.__yanComposer = { el, text, set, clear, append, focus }
  return 'ok'
})()
