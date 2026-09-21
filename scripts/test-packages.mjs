/**
 * pi 包管理的单测（方案 §9 的 P2）。
 *
 * ── 为什么必须**真实**跑一次 pi 的 CLI ──
 * 「登记在 settings.json 的 packages 里」和「磁盘上真的有这个包」是两件事：
 * 前者只是 pi 的一个字符串数组，后者取决于 pi 自己怎么装（实测本地路径源
 * **不复制**，存的是一条相对 agent 目录的路径）。合成一个 settings.json
 * 去测，永远发现不了 `..\my-ext` 这种形态。
 *
 * ── 隔离 ──
 * 全程用临时 agent 目录（通过 `configurePackageContext({ agentDir })` 注入）。
 * 测试**绝不碰**真实用户的 `~/.pi/agent` —— 那里有用户自己装的包。
 * 用本地路径包，不联网。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runPackagesTests(ok) {
  const {
    packageNameOf,
    versionOf,
    packageDirOf,
    validatePackageSource,
    readPackageSources,
    listPackages,
    runPackageAction,
    installManagedPiPackage,
    configurePackageContext,
    writePackageSourcesForTest
  } = await import('../out/test/packages.mjs')

  /* ── 1. 纯逻辑：source 的形状 ─────────────────────────── */
  {
    ok(packageNameOf('npm:pi-zh-cn') === 'pi-zh-cn', 'npm: 前缀去掉', packageNameOf('npm:pi-zh-cn'))
    ok(packageNameOf('npm:@scope/pkg') === '@scope/pkg', '@scope 要保住 scope（否则装到错目录）', packageNameOf('npm:@scope/pkg'))
    ok(packageNameOf('npm:pi-zh-cn@1.2.3') === 'pi-zh-cn', '版本后缀不算包名的一部分', packageNameOf('npm:pi-zh-cn@1.2.3'))
    ok(packageNameOf('npm:@scope/pkg@2.0.0') === '@scope/pkg', '@scope + 版本同时存在', packageNameOf('npm:@scope/pkg@2.0.0'))
    ok(packageNameOf('git:github.com/user/repo') === 'repo', 'git 源取仓库名', packageNameOf('git:github.com/user/repo'))
    ok(packageNameOf('git:github.com/user/repo.git') === 'repo', 'git 源的 .git 后缀去掉', packageNameOf('git:github.com/user/repo.git'))
    ok(packageNameOf('C:\\work\\my-ext') === 'my-ext', '本地路径取最后一段', packageNameOf('C:\\work\\my-ext'))
    ok(packageNameOf('') === '', '空串给空（不猜）', packageNameOf(''))

    ok(versionOf('npm:foo@1.2.3') === '1.2.3', '读出 npm 源的版本', versionOf('npm:foo@1.2.3'))
    ok(versionOf('npm:foo') === null, '没有版本时是 null（不是空串）', String(versionOf('npm:foo')))
    ok(versionOf('git:x/y') === null, 'git 源没有版本概念', String(versionOf('git:x/y')))

    ok(validatePackageSource('npm:pi-zh-cn') === null, '合法 npm 源通过')
    ok(validatePackageSource('npm:@scope/pkg@1.0.0') === null, '合法 + 版本通过')
    ok(validatePackageSource('git:github.com/u/r') === null, '合法 git 源通过')
    ok(validatePackageSource('C:\\work\\ext') === null, '合法本地路径通过')
    ok(validatePackageSource('-l') !== null, '**以 - 开头会被当成 CLI 选项 → 必须拒绝**', String(validatePackageSource('-l')))
    ok(validatePackageSource('--no-approve') !== null, '长选项同样拒绝', String(validatePackageSource('--no-approve')))
    ok(validatePackageSource('npm:a b') !== null, '含空格拒绝', String(validatePackageSource('npm:a b')))
    ok(validatePackageSource('') !== null, '空拒绝', String(validatePackageSource('')))
    ok(validatePackageSource('foo') !== null, '没有来源前缀的裸名字拒绝（避免猜是 npm 还是 git）', String(validatePackageSource('foo')))
  }

  /* ── 2. settings.json 的 packages 字段 ─────────────────── */
  {
    const root = mkdtempSync(join(tmpdir(), 'yan-pkg-src-'))
    const f = join(root, 'settings.json')
    writeFileSync(f, JSON.stringify({ packages: ['npm:a', 'npm:b'], theme: 'dark' }))
    const got = readPackageSources(f)
    ok(got.length === 2 && got[0] === 'npm:a', '读出 packages 数组', JSON.stringify(got))
    ok(readPackageSources(join(root, 'missing.json')).length === 0, '文件不存在 = 空数组（不是抛错）')
    writeFileSync(f, JSON.stringify({ packages: 'not-an-array' }))
    ok(readPackageSources(f).length === 0, '字段类型不对时当作空（不让脏数据炸开）')
    writeFileSync(f, JSON.stringify({ packages: ['npm:a', 42, null] }))
    ok(readPackageSources(f).length === 1, '数组里的非字符串元素被过滤', JSON.stringify(readPackageSources(f)))
    rmSync(root, { recursive: true, force: true })
  }

  /* ── 3. packageDirOf：三种 source 形态 ─────────────────── */
  {
    const agent = 'C:\\agent'
    ok(packageDirOf(agent, 'npm:foo') === join(agent, 'npm', 'node_modules', 'foo'), 'npm 源 → npm/node_modules/<name>')
    ok(
      packageDirOf(agent, 'npm:@s/p') === join(agent, 'npm', 'node_modules', '@s', 'p'),
      '@scope 源要拆成两层目录（否则路径是错的）',
      packageDirOf(agent, 'npm:@s/p')
    )
    ok(packageDirOf(agent, '..\\my-ext') === join('C:\\', 'my-ext'), '相对路径按 agentDir 解析', String(packageDirOf(agent, '..\\my-ext')))
    ok(packageDirOf(agent, 'C:\\work\\ext') === 'C:\\work\\ext', '绝对路径原样使用')
    ok(packageDirOf(agent, '') === null, '空 source 给 null', String(packageDirOf(agent, '')))
  }

  /* ── 4. 真实：装 / 列 / 卸（隔离的 agent 目录，本地路径源，不联网）── */
  {
    const root = mkdtempSync(join(tmpdir(), 'yan-pkg-real-'))
    const agent = join(root, 'agent')
    const ext = join(root, 'my-ext')
    mkdirSync(agent, { recursive: true })
    mkdirSync(join(ext, 'extensions'), { recursive: true })
    writeFileSync(
      join(ext, 'package.json'),
      JSON.stringify({ name: 'yan-test-ext', version: '1.2.3', description: '测试用的假扩展', license: 'MIT', keywords: ['pi-package'] })
    )
    writeFileSync(join(ext, 'extensions', 'index.js'), 'export default {}\n')

    const cli = join(process.cwd(), 'resources', 'pi-runtime', 'dist', 'bundle', 'cli.js')
    configurePackageContext({
      agentDir: () => agent,
      bin: () => cli,
      hasRunningTask: () => false,
      isProjectTrusted: () => true
    })

    ok(existsSync(cli), '内置 pi CLI 在（单测要真跑它）', cli)

    const before = listPackages(root)
    ok(before.ok === true && before.entries.length === 0, '隔离目录起始为空（没碰用户真实的包）', JSON.stringify(before.entries.map((e) => e.source)))
    ok(before.agentDir === agent, '列表回报的 agentDir 是注入的那个', before.agentDir)

    const installed = await runPackageAction({ kind: 'install', source: ext, cwd: root })
    ok(installed.ok === true, '真实安装成功', installed.detail ?? installed.error ?? '')
    ok((installed.output ?? '').includes('Installed'), '带回了 pi 自己的输出（用户要看到它做了什么）', (installed.output ?? '').slice(0, 60))

    const after = listPackages(root)
    ok(after.entries.length === 1, '装完列表里有一条', String(after.entries.length))
    const e0 = after.entries[0]
    ok(e0?.installed === true, '标成 installed（磁盘上真能找到 package.json）', JSON.stringify({ installed: e0?.installed, path: e0?.path }))
    ok(e0?.name === 'yan-test-ext', '包名来自 package.json（不是从目录名猜的）', String(e0?.name))
    ok(e0?.version === '1.2.3', '版本来自 package.json', String(e0?.version))
    ok(e0?.description === '测试用的假扩展', '描述来自 package.json', String(e0?.description))
    ok(
      typeof e0?.source === 'string' && /my-ext$/.test(e0.source.replace(/\\/g, '/')),
      'source 是 pi 自己写进去的那条（本地路径会被存成相对路径）',
      String(e0?.source)
    )

    const removed = await runPackageAction({ kind: 'remove', source: e0.source, cwd: root })
    ok(removed.ok === true, '真实卸载成功', removed.detail ?? removed.error ?? '')
    ok(listPackages(root).entries.length === 0, '卸载后列表空了', String(listPackages(root).entries.length))

    /* 装一个不存在的 npm 包：失败要如实回来，且带上 pi 的原始输出 */
    const failed = await runPackageAction({ kind: 'install', source: 'npm:this-package-does-not-exist-yan-test-xyz', cwd: root })
    ok(failed.ok === false, '不存在的包 → 失败', String(failed.ok))
    ok((failed.detail ?? '').length > 0, '失败时带回原始输出（排查第一现场）', (failed.detail ?? '').slice(0, 60))
    ok(listPackages(root).entries.length === 0, '失败没有留下半条登记', String(listPackages(root).entries.length))

    /* 受管下载包只能从 staging 安装，且默认阻止生命周期脚本。 */
    const stagedRoot = join(root, 'managed-staging')
    const stagedPackage = join(stagedRoot, 'op-1', 'payload')
    const lifecycleMarker = join(stagedPackage, 'lifecycle-ran.txt')
    const configuredExtension = join(stagedRoot, 'existing-project-extension.js')
    const configuredExtensionMarker = join(stagedRoot, 'existing-project-extension-ran.txt')
    mkdirSync(join(stagedPackage, 'extensions'), { recursive: true })
    writeFileSync(
      join(stagedPackage, 'package.json'),
      JSON.stringify({
        name: 'yan-managed-ext',
        version: '4.5.6',
        scripts: { prepare: "node -e \"require('fs').writeFileSync('lifecycle-ran.txt', 'ran')\"" }
      })
    )
    writeFileSync(join(stagedPackage, 'extensions', 'index.js'), 'export default {}\n')
    writeFileSync(
      configuredExtension,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(configuredExtensionMarker)}, 'ran'); export default {};\n`
    )
    const escaped = await installManagedPiPackage({
      sourceDir: ext,
      managedRoot: stagedRoot,
      cwd: root,
      name: 'yan-test-ext',
      version: '1.2.3',
      allowLifecycleScripts: false
    })
    ok(escaped.ok === false && /staging/.test(escaped.error ?? ''), '受管包安装：拒绝 staging 根外的来源')
    mkdirSync(join(root, '.pi'), { recursive: true })
    writeFileSync(join(agent, 'trust.json'), JSON.stringify({ [root]: true }, null, 2))
    writeFileSync(
      join(root, '.pi', 'settings.json'),
      JSON.stringify({ extensions: [configuredExtension], packages: [] }, null, 2)
    )
    const beforeUntrustedInstall = readPackageSources(join(root, '.pi', 'settings.json'))
    configurePackageContext({ agentDir: () => agent, bin: () => cli, hasRunningTask: () => false, isProjectTrusted: () => false })
    const untrustedInstall = await installManagedPiPackage({
      sourceDir: stagedPackage,
      managedRoot: stagedRoot,
      cwd: root,
      name: 'yan-managed-ext',
      version: '4.5.6',
      allowLifecycleScripts: false
    })
    ok(!untrustedInstall.ok && /尚未获 Pi 项目信任/.test(untrustedInstall.error ?? ''), '受管包：未信任项目时拒绝项目级安装')
    ok(
      JSON.stringify(readPackageSources(join(root, '.pi', 'settings.json'))) === JSON.stringify(beforeUntrustedInstall),
      '受管包：未信任时没有改项目配置'
    )
    configurePackageContext({ agentDir: () => agent, bin: () => cli, hasRunningTask: () => false, isProjectTrusted: () => true })
    const managedInstalled = await installManagedPiPackage({
      sourceDir: stagedPackage,
      managedRoot: stagedRoot,
      cwd: root,
      name: 'yan-managed-ext',
      version: '4.5.6',
      allowLifecycleScripts: false
    })
    ok(managedInstalled.ok, '受管包：从精确 staging 目录做项目级安装', managedInstalled.detail ?? managedInstalled.error ?? '')
    ok(!existsSync(configuredExtensionMarker), 'pi 包管理命令不会加载既有项目扩展')
    ok(!existsSync(lifecycleMarker), '受管包：Pi 本地目录登记不执行 lifecycle scripts')
    const managedSource = managedInstalled.listing?.entries.find((e) => e.name === 'yan-managed-ext')?.source
    ok(!!managedSource, '受管包：pi 清单核实了候选名与精确版本')
    if (managedSource) {
      /* 项目扩展回归探针只覆盖 package 命令；删除后续 remove 用到的配置负担。 */
      writeFileSync(join(root, '.pi', 'settings.json'), JSON.stringify({ packages: [managedSource] }, null, 2))
      const removedManaged = await runPackageAction({ kind: 'remove', source: managedSource, local: true, cwd: root })
      ok(removedManaged.ok, '受管包 fixture 可按项目作用域移除', removedManaged.error ?? '')
      const scriptsAllowed = await installManagedPiPackage({
        sourceDir: stagedPackage,
        managedRoot: stagedRoot,
        cwd: root,
        name: 'yan-managed-ext',
        version: '4.5.6',
        allowLifecycleScripts: true
      })
      ok(scriptsAllowed.ok, '受管包：已授权时生命周期脚本策略可显式打开', scriptsAllowed.error ?? '')
      ok(!existsSync(lifecycleMarker), 'pi 对本地 staging 目录的登记不执行 lifecycle scripts（脚本执行应只发生在专用 npm 安装步骤）')
      const finalSource = scriptsAllowed.listing?.entries.find((e) => e.name === 'yan-managed-ext')?.source
      if (finalSource) {
        const cleanup = await runPackageAction({ kind: 'remove', source: finalSource, local: true, cwd: root })
        ok(cleanup.ok, '受管包 fixture 在隔离项目中清理完成')
      }
    }

    /* 参数注入：以 - 开头的 source 在**发起前**就被挡下 */
    const inject = await runPackageAction({ kind: 'install', source: '--no-approve', cwd: root })
    ok(inject.ok === false && !inject.detail, '带选项形状的 source 在发起前被拒（不落到命令行）', String(inject.error))

    /* 有任务在跑 → 拒绝（方案 §9 的「任务的生效时机」）*/
    configurePackageContext({
      agentDir: () => agent,
      bin: () => cli,
      hasRunningTask: () => true
    })
    const busy = await runPackageAction({ kind: 'install', source: ext, cwd: root })
    ok(busy.ok === false, '有任务在跑时拒绝改插件', String(busy.error))
    ok(/任务/.test(busy.error ?? ''), '说明理由（有任务在运行）', String(busy.error).slice(0, 40))
    ok(listPackages(root).entries.length === 0, '被拒时一个字节都没写', String(listPackages(root).entries.length))

    /* 复位，避免影响别的测试 */
    configurePackageContext({ agentDir: () => agent, bin: () => cli, hasRunningTask: () => false })

    rmSync(root, { recursive: true, force: true })
  }

  /* ── 5. 「登记着但磁盘上没有」要如实标出来 ─────────────── */
  {
    const root = mkdtempSync(join(tmpdir(), 'yan-pkg-ghost-'))
    const agent = join(root, 'agent')
    mkdirSync(agent, { recursive: true })
    writePackageSourcesForTest(join(agent, 'settings.json'), ['npm:ghost-package-that-is-not-installed'])
    const listed = listPackages(root, agent)
    ok(listed.entries.length === 1, '读到了那条登记', String(listed.entries.length))
    ok(listed.entries[0].installed === false, '磁盘上没有 → installed: false（界面上要显示成异常，不能当正常）')
    ok(listed.entries[0].version === null, '读不到元信息时版本是 null（不是编一个）', String(listed.entries[0].version))
    rmSync(root, { recursive: true, force: true })
  }

  /* ── 6. 项目作用域：同一 source 在项目里要覆盖显示 ──────── */
  {
    const root = mkdtempSync(join(tmpdir(), 'yan-pkg-scope-'))
    const agent = join(root, 'agent')
    mkdirSync(agent, { recursive: true })
    mkdirSync(join(root, '.pi'), { recursive: true })
    writePackageSourcesForTest(join(agent, 'settings.json'), ['npm:shared-pkg'])
    writePackageSourcesForTest(join(root, '.pi', 'settings.json'), ['npm:shared-pkg'])
    const listed = listPackages(root, agent)
    ok(listed.entries.length === 1, '同一 source 不重复列两次', String(listed.entries.length))
    ok(listed.entries[0].scope === 'project', '项目作用域的那条优先（它才是当前会话生效的）', listed.entries[0].scope)
    rmSync(root, { recursive: true, force: true })
  }
}
