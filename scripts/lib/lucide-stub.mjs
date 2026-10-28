import { createRequire } from 'node:module'

let contents

export function lucideStubSource() {
  if (!contents) {
    const names = Object.keys(createRequire(import.meta.url)('lucide-react')).filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default')
    contents = `${names.map(name => `export function ${name}(){return null}`).join('\n')}\nexport default {}`
  }
  return contents
}
