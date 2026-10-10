import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)

/** Uses the installed phone runtime with an isolated profile, never a gateway. */
export async function runHermesPhoneProbe({ root, temp, port, config, id }) {
  const serial = process.env.YAN_ADB_SERIAL || (await exec('adb', ['get-serialno'], { windowsHide: true, timeout: 10000 })).stdout.trim()
  if (!/^[a-zA-Z0-9_-]+$/.test(serial)) throw Error('Invalid adb serial')
  const adb = async (...args) => {
    const result = await exec('adb', ['-s', serial, ...args], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 60000 })
    if (result.stderr.includes('error:')) throw Error('adb operation failed')
    if (result.stdout.trim()) process.stdout.write(result.stdout)
    if (result.stderr.trim()) process.stderr.write(result.stderr)
    return result
  }
  const name = `inkstone-probe-${randomUUID()}`
  const phone = `/tmp/${name}`
  const hostPhone = `/data/local/hermes/rootfs${phone}`
  let reversed = false
  try {
    await adb('shell', `su -M -c 'mkdir -p ${hostPhone}/plugins/inkstone; chmod 700 ${hostPhone}'`)
    for (const file of ['plugin.yaml', '__init__.py', 'client.py', 'approvals.py', 'connect.py', 'README.md']) {
      await adb('push', join(root, 'integrations/hermes-inkstone', file), `${hostPhone}/plugins/inkstone/${file}`)
    }
    await adb('push', config, `${hostPhone}/connection.json`)
    await adb('push', join(root, 'scripts/probe/hermes-plugin-desktop.py'), `${hostPhone}/probe.py`)
    const script = join(temp, 'phone-probe.sh')
    await writeFile(script, `#!/bin/sh\nset -eu\nexport HERMES_HOME=${phone}\nexport PYTHONDONTWRITEBYTECODE=1\nexport PYTHONIOENCODING=utf-8\nexport PYTHONPATH=/opt/hermes/agent\nexport INKSTONE_PLUGIN_PATH=${phone}/plugins/inkstone\nexport INKSTONE_CONNECTION_FILE=${phone}/connection.json\nexport INKSTONE_DESKTOP_FIXTURE_ID=${id}\nexport INKSTONE_OFFICIAL_HERMES=1\ncd /opt/hermes/agent\nexec /opt/hermes/agent/venv/bin/python ${phone}/probe.py\n`)
    await adb('push', script, `${hostPhone}/run.sh`)
    await adb('shell', `su -M -c 'chown -R 2951:2951 ${hostPhone}; chmod 600 ${hostPhone}/connection.json'`)
    await adb('reverse', `tcp:${port}`, `tcp:${port}`)
    reversed = true
    await adb('shell', `su -M -c 'sh /data/local/hermes/run-hermes.sh /bin/sh ${phone}/run.sh'`)
  } finally {
    // Preserve non-secret diagnostics, remove only this run's credential file.
    await adb('shell', `su -M -c 'rm -f ${hostPhone}/connection.json'`).catch(() => {})
    if (reversed) await adb('reverse', '--remove', `tcp:${port}`).catch(() => {})
  }
}
