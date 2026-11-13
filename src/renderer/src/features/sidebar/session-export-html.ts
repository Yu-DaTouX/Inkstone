import { createElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const STYLE = [
  ':root{color-scheme:light dark;--ink:#1b1b1f;--muted:#6b6b76;--line:#e2e2e8;--soft:#f5f5f8;--page:#fff}',
  '@media (prefers-color-scheme:dark){:root{--ink:#e8e8ee;--muted:#9a9aa6;--line:#2c2c34;--soft:#1c1c22;--page:#111114}}',
  'body{margin:0;background:var(--page);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
  'main{max-width:820px;margin:0 auto;padding:40px 24px 80px;overflow-wrap:anywhere}',
  'h1{font-size:1.6rem;line-height:1.3;margin:0 0 12px}',
  'h2,h3,h4,h5,h6{margin:24px 0 8px;line-height:1.35}',
  'hr+p{font-size:.8rem;letter-spacing:.04em;color:var(--muted);margin-bottom:6px}',
  'p,ul,ol,pre,table,blockquote{margin:0 0 14px}',
  'a{color:inherit;text-decoration:underline;text-underline-offset:2px}',
  'blockquote{padding:2px 14px;border-left:3px solid var(--line);color:var(--muted)}',
  'code{font:.875em/1.5 ui-monospace,"Cascadia Code",Consolas,monospace;background:var(--soft);padding:.1em .35em;border-radius:4px}',
  'pre{background:var(--soft);padding:12px 14px;border-radius:8px;overflow-x:auto}',
  'pre code{background:none;padding:0}',
  'table{border-collapse:collapse;display:block;overflow-x:auto}',
  'th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}',
  'hr{border:0;border-top:1px solid var(--line);margin:32px 0 14px}'
].join('\n')

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function sessionHtmlDocument(markdown: string, title: string, lang: string): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const body = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], disallowedElements: ['img'] }, markdown))
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    '<body>',
    `<main>\n${body}\n</main>`,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
