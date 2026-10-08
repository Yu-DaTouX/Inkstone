/**
 * 手机配对与设备表的存储语义（H02 / H05 回归）。
 *
 * 全部在临时目录里跑：合成设备名、本进程生成的配对码、不读真实设备表、
 * 不碰真实配对码与令牌、不发任何网络请求。
 *
 * 钉住的三件事：
 *   · 一个一次性配对码并发只能产出一个令牌（「验证 → 消费 → 落盘」必须串行）；
 *   · 写盘失败不能让之后的保存全部失效（队列不被毒化），且失败的操作不进内存；
 *   · 撤销必须「落盘成功才算完成」，失败时内存保持未撤销（否则重启后设备又生效）。
 */
export async function runRemoteDeviceTests(ok, { RemoteDeviceStore }) {
  const { mkdtemp, mkdir, rename, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  /* ---- 1. 同一个配对码并发配对 ---- */
  {
    const dir = await mkdtemp(join(tmpdir(), 'yan-devices-conc-'))
    const store = new RemoteDeviceStore(dir)
    await store.list()
    const pairing = store.startPairing()
    const results = await Promise.all([
      store.pair(pairing.code, '并发 A'),
      store.pair(pairing.code, '并发 B')
    ])
    const succeeded = results.filter((r) => r.ok)
    ok(succeeded.length === 1, '并发配对同一个码：只有一次成功（一次性码）', `成功 ${succeeded.length} 次`)
    const accepted = await Promise.all(succeeded.map((r) => store.authenticate(r.token)))
    ok(accepted.filter(Boolean).length === succeeded.length, '配对成功后签发的令牌可用')
    const list = await store.list()
    ok(list.length === 1, '设备表里只有一台设备', String(list.length))
    const disk = JSON.parse(await readFile(join(dir, 'remote-devices.json'), 'utf8'))
    ok(disk.devices.length === 1, '磁盘上也只有一台设备', String(disk.devices.length))
    const loser = results.find((r) => !r.ok)
    ok(loser?.error === 'no_pairing', '后到的请求看到「没有正在进行的配对」', loser?.error)
  }

  /* ---- 2. 设备满时配对码不作废（保留给用户清掉旧设备后重试） ---- */
  {
    const dir = await mkdtemp(join(tmpdir(), 'yan-devices-limit-'))
    const store = new RemoteDeviceStore(dir)
    await store.list()
    for (let i = 0; i < 20; i += 1) {
      const pairing = store.startPairing()
      const result = await store.pair(pairing.code, `设备 ${i}`)
      if (!result.ok) throw new Error(`准备 20 台设备时第 ${i} 次失败：${result.error}`)
    }
    const pairing = store.startPairing()
    const full = await store.pair(pairing.code, '第 21 台')
    ok(full.ok === false && full.error === 'device_limit', '超过设备上限时明确报 device_limit', full.error)
    ok(store.currentPairing() !== null, '没名额时配对码不被消费（用户可清理后重试）')
    const disk = JSON.parse(await readFile(join(dir, 'remote-devices.json'), 'utf8'))
    ok(disk.devices.length === 20, '磁盘上仍只有 20 台设备', String(disk.devices.length))
  }

  /* ---- 3. 写盘失败：如实报错、不进内存、之后能恢复 ---- */
  {
    const dir = await mkdtemp(join(tmpdir(), 'yan-devices-fail-'))
    const store = new RemoteDeviceStore(dir)
    await store.list()
    /* 用同名目录占据目标路径，让原子 rename 失败 */
    await mkdir(join(dir, 'remote-devices.json'), { recursive: true })
    let firstRejected = false
    try {
      const pairing = store.startPairing()
      await store.pair(pairing.code, '第一次失败')
    } catch {
      firstRejected = true
    }
    ok(firstRejected, '写盘失败会如实抛错（不假装成功）')
    ok((await store.list()).length === 0, '写盘失败的设备不进内存（不会在下次保存时偷偷生效）')
    await rename(join(dir, 'remote-devices.json'), join(dir, 'obstacle-removed'))
    const pairing = store.startPairing()
    const repaired = await store.pair(pairing.code, '修复后')
    ok(repaired.ok === true, '阻碍解除后队列能继续保存（不被一次失败毒化）', JSON.stringify(repaired))
    const disk = JSON.parse(await readFile(join(dir, 'remote-devices.json'), 'utf8'))
    ok(disk.devices.length === 1 && disk.devices[0].name === '修复后', '磁盘上是修复后那台设备')
  }

  /* ---- 4. 撤销：成功要落盘，失败不能只在内存生效 ---- */
  {
    const dir = await mkdtemp(join(tmpdir(), 'yan-devices-revoke-'))
    const store = new RemoteDeviceStore(dir)
    await store.list()
    const pairing = store.startPairing()
    const paired = await store.pair(pairing.code, '待撤销设备')
    ok(paired.ok === true, '准备：配对一台设备')

    /* 正常撤销 */
    const other = store.startPairing()
    const second = await store.pair(other.code, '第二台设备')
    ok(second.ok === true, '准备：配对第二台设备')
    const revoked = await store.revoke(second.device.id)
    ok(revoked === true, '撤销返回成功')
    const diskAfterRevoke = JSON.parse(await readFile(join(dir, 'remote-devices.json'), 'utf8'))
    ok(
      diskAfterRevoke.devices.find((d) => d.id === second.device.id)?.revokedAt !== null,
      '撤销已落盘（重启后不会复活）'
    )
    ok((await store.authenticate(second.token)) === null, '撤销后的令牌认不出来')

    /* 写盘失败时撤销：内存也必须保持未撤销 */
    await rename(join(dir, 'remote-devices.json'), join(dir, 'backup.json'))
    await mkdir(join(dir, 'remote-devices.json'), { recursive: true })
    let revokeRejected = false
    try {
      await store.revoke(paired.device.id)
    } catch {
      revokeRejected = true
    }
    ok(revokeRejected, '撤销写盘失败会如实抛错')
    const stillActive = (await store.list()).find((d) => d.id === paired.device.id)
    ok(stillActive?.revokedAt === null, '**撤销失败时内存保持未撤销**（不会出现「界面说失败、进程内却已失效」）')
    ok((await store.authenticate(paired.token)) !== null, '撤销失败后令牌仍然可用（状态一致）')
  }
}
