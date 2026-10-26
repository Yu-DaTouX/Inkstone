import { spawnSync } from 'node:child_process'

export function resolvePython() {
  if (process.env.YAN_TEST_PYTHON) return process.env.YAN_TEST_PYTHON
  for (const command of ['python', 'python3', 'py']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    if (!probe.error && probe.status === 0 && /^Python \d/.test(`${probe.stdout}${probe.stderr}`.trim())) return command
  }
  throw new Error('找不到可用的 Python：安装 Python 3 或设置 YAN_TEST_PYTHON')
}
