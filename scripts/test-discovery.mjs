/**
 * 联网发现的纯逻辑与适配器映射（`src/shared/discovery.ts`、
 * `src/main/capabilities/discovery/discover.ts`，实施-04 S5）。
 *
 * 这一片能离线验的是**判断**：脱敏该去掉什么、排名该看什么、候选该截到几条、
 * 源挂了会不会编造包名、指纹变了没有。真实目录检索证据在本片另附
 * （`docs/plan/证据-04-S5-联网发现.md` + live 场景 `discnet`）——
 * 固定的 fixture 断言不了「源今天真的返回了这些东西」。
 */
export async function runDiscoveryTests(ok, modules) {
  const { discover, shared } = modules

  /* ------------------------------------------------ 1. 检索词脱敏（§7.1） */

  {
    const dirty =
      '帮我读 C:\\Users\\Someone\\Desktop\\客户的报价表.xlsx，用 https://internal.corp/api/v2 拉，' +
      'token sk-live-abcdefghijklmnop 和 mail@example.com，hash 3f786850e387550fdab836ed7e6dc881de23001b'
    const clean = shared.sanitizeDiscoveryQuery(dirty)
    ok(!/Users|Desktop|xlsx/.test(clean), '脱敏：去掉 Windows 绝对路径与文件名', clean)
    ok(!/internal\.corp/.test(clean), '脱敏：去掉内部 URL')
    ok(!/sk-live-/.test(clean), '脱敏：去掉密钥形状的串')
    ok(!/mail@example\.com/.test(clean), '脱敏：去掉邮箱')
    ok(!/3f786850/.test(clean), '脱敏：去掉长 hex')
    ok(clean.includes('报价表') || clean.includes('帮我读'), '脱敏：保留通用任务描述', clean)

    ok(shared.sanitizeDiscoveryQuery('sk-live-abcdefghijklmnop') === '', '脱敏：只剩密钥时结果为空')
    ok(!shared.discoveryQueryUsable('C:\\Users\\x\\a.xlsx'), '脱敏：只有本地路径时判为不可用')
    ok(shared.discoveryQueryUsable('read excel files'), '脱敏：通用描述可用')
    ok(shared.sanitizeDiscoveryQuery('x'.repeat(500)).length <= 120, '脱敏：检索词有长度上限')
  }

  /* ------------------------------------------------------------ 2. 排名 */

  {
    const base = {
      summary: '读取 excel 表格',
      discoveredAt: '2026-09-19T00:00:00.000Z',
      sourceUrls: ['https://example.test/a'],
      requirements: [],
      auth: 'none',
      verification: 'metadata-only'
    }
    const candidates = [
      { ...base, candidateId: 'npm:no-repo@1.0.0', kind: 'skill', title: 'reading excel', installKind: 'pi-package' },
      {
        ...base,
        candidateId: 'npm:with-repo@1.0.0',
        kind: 'skill',
        title: 'reading excel',
        installKind: 'pi-package',
        repository: 'https://github.com/x/y',
        version: '1.0.0'
      },
      {
        ...base,
        candidateId: 'npm:needs-auth@1.0.0',
        kind: 'skill',
        title: 'reading excel',
        installKind: 'pi-package',
        auth: 'required'
      },
      {
        ...base,
        candidateId: 'npm:mac-only@1.0.0',
        kind: 'skill',
        title: 'reading excel',
        installKind: 'pi-package',
        requirements: ['requires macos only']
      }
    ]
    const ranked = shared.rankCandidates(candidates, { goalText: '读取 excel 表格' })
    const order = ranked.map((r) => r.candidate.candidateId)
    ok(order[0] === 'npm:with-repo@1.0.0', '排名：有仓库 + 确切版本的排最前', order.join(','))
    ok(
      order.indexOf('npm:needs-auth@1.0.0') > order.indexOf('npm:no-repo@1.0.0'),
      '排名：需要认证的排在同等的免认证候选之后'
    )
    ok(order[order.length - 1] === 'npm:mac-only@1.0.0', '排名：平台不兼容的沉底', order.join(','))
    ok(
      ranked[0].reasons.some((r) => /目标词命中/.test(r)),
      '排名：给出可读理由（模型要能解释为什么选它）',
      ranked[0].reasons.join(' / ')
    )
    /* §8：下载量不是可信证明 —— 评分理由里不该出现下载量这类信号。 */
    ok(
      !ranked.some((r) => r.reasons.some((x) => /下载|download/i.test(x))),
      '排名：评分因子不含下载量'
    )
  }

  /* ------------------------------------------------ 3. 候选截断（§7.2） */

  {
    const many = Array.from({ length: 20 }, (_, i) => ({
      candidateId: `npm:p${i}@1.0.0`,
      kind: 'skill',
      title: `p${i}`,
      summary: '描述',
      discoveredAt: '2026-09-19T00:00:00.000Z',
      sourceUrls: ['https://example.test'],
      requirements: [],
      auth: 'none',
      installKind: 'pi-package',
      verification: 'metadata-only'
    }))
    ok(shared.selectCandidates(shared.rankCandidates(many), shared.MAX_CANDIDATES).length === 8, '截断：候选最多八项')
    ok(shared.MAX_PAGES_PER_SOURCE === 2, '上限：每源最多两页')
    ok(shared.MAX_QUERY_REWRITES === 2, '上限：每轮最多两次查询改写')
  }

  /* -------------------------------------------- 4. 适配器映射（真响应形状） */

  {
    const now = '2026-09-19T00:00:00.000Z'
    /* 这两段是真实响应的**结构**（2026-09-19 实测），字段照抄，值取自公开目录。 */
    const npm = discover.npmCandidateOf(
      {
        package: {
          name: 'mcp-typegen',
          version: '0.1.0',
          description: 'codegen',
          links: { npm: 'https://www.npmjs.com/package/mcp-typegen', repository: 'https://github.com/a/b' },
          publisher: { username: 'someone' }
        }
      },
      now
    )
    ok(npm?.candidateId === 'npm:mcp-typegen@0.1.0', 'npm 适配器：ID 固定到确切版本', String(npm?.candidateId))
    ok(npm?.verification === 'metadata-only', 'npm 适配器：不假装已验证')
    ok(/SKILL\.md/.test(npm?.requirements.join(' ') ?? ''), 'npm 适配器：如实写明「未核实包内是否含 SKILL.md」')
    ok(npm?.sourceUrls.length === 2, 'npm 适配器：给出可回溯的原始来源链接', JSON.stringify(npm?.sourceUrls))
    ok(npm?.localPackage?.registryType === 'npm' && npm.localPackage.identifier === 'mcp-typegen' && npm.localPackage.version === '0.1.0', 'npm 适配器：固定 registry 类型、包名与精确版本')
    ok(discover.npmCandidateOf({ package: { name: 'x' } }, now) === null, 'npm 适配器：缺版本直接丢弃（不能固定就不算候选）')

    const skill = discover.skillDirectoryCandidateOf({
      id: 'read-excel',
      title: 'Read Excel',
      description: '按固定流程读取工作簿',
      version: '1.2.3',
      repository: 'https://github.com/example/read-excel',
      files: [{
        path: 'skills/read-excel/SKILL.md',
        url: 'https://raw.githubusercontent.com/example/read-excel/v1.2.3/skills/read-excel/SKILL.md',
        sha256: 'b'.repeat(64)
      }]
    }, 'https://skills.example.test/catalog', now)
    ok(skill?.installKind === 'skill-files', 'Skill 目录：逐文件来源映射为 skill-files')
    ok(skill?.version === '1.2.3' && skill?.skillFiles?.[0] === 'skills/read-excel/SKILL.md', 'Skill 目录：固定精确版本与安全相对路径')
    ok(skill?.skillFileHashes?.['skills/read-excel/SKILL.md'] === 'b'.repeat(64), 'Skill 目录：保留逐文件 SHA-256')
    ok(skill?.skillFileUrls?.['skills/read-excel/SKILL.md']?.startsWith('https://raw.githubusercontent.com/'), 'Skill 目录：保留逐文件 HTTPS 来源')
    ok(discover.planForCandidate({ candidate: skill, goalId: 'g', projectId: 'p' }).plan.policyResult === 'needs-authorization', 'Skill 目录：元数据候选仍需独立授权')
    ok(discover.skillDirectoryCandidateOf({ id: 'bad', version: '1.0.0', files: [{ path: 'README.md', url: 'https://example.test/readme', sha256: 'b'.repeat(64) }] }, 'https://skills.example.test/catalog', now) === null, 'Skill 目录：README / 非 SKILL.md 不成为候选')

    const mcp = discover.mcpCandidateOf(
      {
        server: {
          name: 'ac.inference.sh/mcp',
          description: 'Run 150+ AI apps',
          title: 'inference.sh',
          version: '1.0.0',
          remotes: [{ type: 'streamable-http', url: 'https://sh.inference.ac' }]
        }
      },
      now
    )
    ok(mcp?.kind === 'mcp-server' && mcp.candidateId === 'mcp-registry:ac.inference.sh/mcp@1.0.0', 'MCP 适配器：ID 带服务名与版本', String(mcp?.candidateId))
    ok(mcp?.transport === 'streamable-http', 'MCP 适配器：远程端点映射成 streamable-http')
    ok(mcp?.installKind === 'remote', 'MCP 适配器：远程服务不伪造下载步骤（installKind=remote）')
    ok(mcp?.auth === 'unknown', 'MCP 适配器：认证未知就写 unknown（不猜成 none）')
    ok(
      (mcp?.requirements.join(' ') ?? '').includes('远程端点，无需本地安装'),
      'MCP 适配器：把「无需本地安装」如实写进运行要求'
    )

    const localMcp = discover.mcpCandidateOf({
      server: {
        name: 'io.example/math',
        version: '2.0.0',
        packages: [{
          registryType: 'npm',
          identifier: '@example/math-mcp',
          version: '2.1.0',
          runtimeHint: 'node',
          fileSha256: 'a'.repeat(64),
          transport: { type: 'stdio' }
        }]
      }
    }, now)
    ok(localMcp?.installKind === 'mcp-package', 'MCP Registry：无 remote、但有 package 时识别成本地 MCP 包')
    ok(localMcp?.localPackage?.identifier === '@example/math-mcp' && localMcp.localPackage.version === '2.1.0', 'MCP Registry：包身份使用包自己的精确版本，不混用 server version')
    ok(localMcp?.localPackage?.fileSha256 === 'a'.repeat(64), 'MCP Registry：保留可选 package SHA-256 锚点')
    ok(discover.planForCandidate({ candidate: localMcp, goalId: 'g', projectId: 'p' }).plan.policyResult === 'needs-authorization', 'MCP Registry：支持的 npm 包仍需独立授权，metadata-only 不自动执行')

    const unsupportedMcp = discover.mcpCandidateOf({
      server: {
        name: 'io.example/python',
        version: '1.0.0',
        packages: [{ registryType: 'pypi', identifier: 'example-mcp', version: '1.0.0', runtimeHint: 'uvx' }]
      }
    }, now)
    ok(discover.planForCandidate({ candidate: unsupportedMcp, goalId: 'g', projectId: 'p' }).plan.policyResult === 'unsupported', 'MCP Registry：未实现的 PyPI/uvx 明确 unsupported，不擅自装运行时')
  }

  /* ------------------------------- 5. 源失败 / 部分失败都不编造（§7.2） */

  {
    const boom = () => Promise.reject(new Error('offline'))
    const allDown = await discover.discoverCapabilities({
      queryText: 'read excel files',
      fetchImpl: boom,
      now: () => new Date('2026-09-19T00:00:00.000Z')
    })
    ok(allDown.candidates.length === 0, '源全挂：候选为空（不编造包名）')
    ok(/暂时无法搜索/.test(allDown.reason ?? ''), '源全挂：给出「暂时无法搜索」这个可读原因', String(allDown.reason))
    ok(allDown.sources.length === 2 && allDown.sources.every((s) => !s.ok), '源全挂：每个源都如实记为失败')
    ok(
      allDown.sources.every((s) => typeof s.error === 'string' && s.error.length > 0),
      '源全挂：失败带具体错误（不是笼统「不可用」）'
    )

    /* 一个源通、一个源挂：仍要给出结果（§7.2：密钥缺失时仍能做目录检索）。 */
    const halfDown = await discover.discoverCapabilities({
      queryText: 'filesystem',
      now: () => new Date('2026-09-19T00:00:00.000Z'),
      fetchImpl: (url) => {
        if (String(url).includes('registry.npmjs.org')) return Promise.reject(new Error('npm down'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [
                { server: { name: 'com.example/fs', description: '文件系统', version: '2.0.0', remotes: [{ type: 'streamable-http', url: 'https://fs.example' }] } }
              ],
              metadata: { count: 1 }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      }
    })
    ok(halfDown.candidates.length === 1, '单源可用：仍返回候选', String(halfDown.candidates.length))
    ok(halfDown.reason === null, '单源可用：不给「无法搜索」的假原因')
    ok(
      halfDown.sources.filter((s) => s.ok).length === 1 && halfDown.sources.filter((s) => !s.ok).length === 1,
      '单源可用：两个源的状态分开记录'
    )

    const badQuery = await discover.discoverCapabilities({ queryText: 'C:\\Users\\x\\secret.xlsx', fetchImpl: boom })
    ok(badQuery.sources.length === 0 && /脱敏后为空/.test(badQuery.reason ?? ''), '脱敏后为空：不发请求，直接说明原因')
  }

  /* -------------------------------------------------- 6. 指纹与计划（§8） */

  {
    const mk = (extra = {}) => ({
      candidateId: 'npm:x@1.0.0',
      kind: 'skill',
      title: 'x',
      summary: '描述',
      discoveredAt: '2026-09-19T00:00:00.000Z',
      sourceUrls: ['https://example.test'],
      requirements: [],
      auth: 'none',
      installKind: 'pi-package',
      verification: 'metadata-only',
      localPackage: { registryType: 'npm', identifier: 'x', version: '1.0.0' },
      ...extra
    })
    const d1 = shared.stableDigestOf(mk())
    const d2 = shared.stableDigestOf(mk({ discoveredAt: '2026-09-20T11:11:11.000Z' }))
    ok(d1 === d2, '指纹：抓取时间不影响指纹（否则计划会「永远刚失效」）')
    const d3 = shared.stableDigestOf(mk({ version: '1.0.1' }))
    ok(d1 !== d3, '指纹：版本变化必须让计划失效')
    ok(d1 !== shared.stableDigestOf(mk({ localPackage: { registryType: 'npm', identifier: 'x', version: '1.0.0', fileSha256: '1'.repeat(64) } })), '指纹：目录提供的 package SHA-256 改变会使旧计划失效')

    const planMeta = discover.planForCandidate({ candidate: mk(), goalId: 'g1', projectId: 'p1' })
    ok(planMeta.plan.policyResult === 'needs-authorization', '计划：目录元数据不足以自动接入（needs-authorization）')
    ok(planMeta.plan.pinnedSource === 'npm:x@1.0.0', '计划：固定到确切来源（不因搜索第一名就自动执行）')
    ok(planMeta.plan.scope === 'project-managed', '计划：作用域是项目级受管')

    const unsupported = discover.planForCandidate({
      candidate: mk({ localPackage: { registryType: 'pypi', identifier: 'x', version: '1.0.0', runtimeHint: 'uvx' } }),
      goalId: 'g1',
      projectId: 'p1'
    })
    ok(unsupported.plan.policyResult === 'unsupported', '计划：未实现的包仓库 / 运行时组合明确 unsupported')

    const planAuth = discover.planForCandidate({ candidate: mk({ auth: 'required' }), goalId: 'g1', projectId: 'p1' })
    ok(planAuth.plan.policyResult === 'needs-auth', '计划：需要认证时如实标 needs-auth（不伪装可自动接入）')

    const same = discover.planForCandidate({ candidate: mk(), goalId: 'g1', projectId: 'p1' })
    ok(same.plan.planId === planMeta.plan.planId, '计划：同一候选 + 目标 + 项目 → 同一 planId')
    const refreshedMetadata = discover.planForCandidate({
      candidate: mk({ discoveredAt: '2026-09-20T11:11:11.000Z' }),
      goalId: 'g1',
      projectId: 'p1'
    })
    ok(refreshedMetadata.plan.planId === planMeta.plan.planId, '计划：仅抓取时间变化不改变 planId')
    const sourceDrift = discover.planForCandidate({ candidate: mk({ integrity: 'sha512-new-source-integrity' }), goalId: 'g1', projectId: 'p1' })
    ok(sourceDrift.plan.planId !== planMeta.plan.planId, '计划：同候选来源完整性变化生成新 planId（旧引用不映射新制品）')
    const other = discover.planForCandidate({ candidate: mk(), goalId: 'g2', projectId: 'p1' })
    ok(other.plan.planId !== planMeta.plan.planId, '计划：换目标就是另一个计划')
  }
}
