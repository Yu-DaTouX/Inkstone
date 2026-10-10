import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function runHtmlArtifactPreviewTests() {
  await build({ entryPoints: ['src/main/html-artifact-preview-store.ts', 'src/shared/html-artifact-preview.ts'], outdir: 'out/test/html-artifact', outbase: 'src', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const { HtmlArtifactPreviewStore } = await import('../out/test/html-artifact/main/html-artifact-preview-store.js')
  const shared = await import('../out/test/html-artifact/shared/html-artifact-preview.js')
  const root = await mkdtemp(join(tmpdir(), 'yan-html-preview-unit-'))
  let count = 0
  const ok = (value, label) => {
    if (!value) throw new Error(`HTML preview: ${label}`)
    count++
  }
  try {
    const managed = join(root, 'artifacts')
    const outside = join(root, 'outside')
    await mkdir(managed)
    await mkdir(outside)
    const file = join(managed, 'page.HTML')
    await writeFile(file, '<html><body>完整页面<script>window.marker=1</script></body></html>')
    const store = new HtmlArtifactPreviewStore(managed, 2)
    const first = await store.prepare(file)
    ok(first.ok, 'managed HTML creates a preview')
    ok(first.ok && store.read(first.url).includes('window.marker=1'), 'snapshot keeps inline scripts for isolated execution')
    ok(first.ok && shared.htmlArtifactToken(first.url)?.length === 32, 'URL carries an opaque random token, not a file path')
    ok(first.ok && store.read(first.url + '#focus') !== null, 'document fragment retains snapshot identity')
    ok(first.ok && store.read(first.url + '?path=other') === null, 'query cannot redirect the snapshot')
    ok(shared.htmlArtifactToken('inkstone-html://bad/index.html') === null, 'invalid token is rejected')
    ok(shared.htmlArtifactToken('file:///index.html') === null, 'file URL is not a snapshot URL')
    ok(shared.htmlArtifactToken('inkstone-html://' + 'a'.repeat(32) + '/other.html') === null, 'only the exact document path is allowed')
    await writeFile(file, '<p>changed</p>')
    ok(first.ok && !store.read(first.url).includes('changed'), 'disk edits do not change an active preview')
    const second = await store.prepare(file)
    ok(second.ok && second.url !== first.url, 'each mounted preview gets its own token')
    ok((await store.prepare(file)).error === 'busy', 'active preview count is bounded')
    store.release(first.url)
    ok(store.read(first.url) === null, 'unmounted preview token no longer works')
    store.release(second.url)
    ok((await store.prepare('relative.html')).error === 'outside', 'relative paths are not accepted')
    await writeFile(join(outside, 'private.html'), '<p>private</p>')
    ok((await store.prepare(join(outside, 'private.html'))).error === 'outside', 'outside file is not exposed')
    await writeFile(join(managed, 'note.txt'), 'not html')
    ok((await store.prepare(join(managed, 'note.txt'))).error === 'type', 'non-HTML artifact is not executed')
    ok((await store.prepare(join(managed, 'missing.html'))).error === 'read', 'missing file reports a read error')
    await writeFile(join(managed, 'empty.html'), '')
    ok((await store.prepare(join(managed, 'empty.html'))).error === 'size', 'empty document is rejected')
    await writeFile(join(managed, 'large.html'), Buffer.alloc(shared.HTML_ARTIFACT_MAX_BYTES + 1))
    ok((await store.prepare(join(managed, 'large.html'))).error === 'size', 'oversized document is not truncated and rendered')
    await symlink(outside, join(managed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    ok((await store.prepare(join(managed, 'escape', 'private.html'))).error === 'outside', 'junction/symlink cannot escape the artifact root')
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => store.prepare(file)))
    ok(concurrent.filter((result) => result.ok).length === 2, 'concurrent prepare cannot bypass slot limit')
    store.clear()
    ok(concurrent.every((result) => !result.ok || store.read(result.url) === null), 'renderer reload clears all existing preview tokens')
    const pending = store.prepare(file)
    store.clear()
    ok((await pending).error === 'read', 'late read cannot repopulate snapshots after renderer reload')
    const afterReload = await store.prepare(file)
    ok(afterReload.ok, 'new preview can be created after reload')
    if (afterReload.ok) store.release(afterReload.url)
    ok(shared.isHtmlArtifact({ filename: 'diagram.HTM' }), 'legacy HTM extension is recognized')
    ok(shared.isHtmlArtifact({ filename: 'diagram', mediaType: 'text/html; charset=utf-8' }), 'HTML media type is recognized')
    ok(!shared.isHtmlArtifact({ filename: 'readme.md', mediaType: 'text/markdown' }), 'Markdown is not executed')
    ok(shared.HTML_ARTIFACT_SANDBOX === 'allow-scripts', 'sandbox never grants same-origin, downloads, popups or navigation')
    ok(shared.HTML_ARTIFACT_CSP.includes("connect-src 'none'") && shared.HTML_ARTIFACT_CSP.includes("frame-src 'none'"), 'document policy blocks networking and child frames')
    ok(!shared.HTML_ARTIFACT_CSP.includes('unsafe-eval') && !shared.HTML_ARTIFACT_CSP.includes("'self'"), 'document policy does not grant eval or same-origin resources')
    console.log(`HTML artifact preview: ${count} checks passed`)
    return count
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runHtmlArtifactPreviewTests()
