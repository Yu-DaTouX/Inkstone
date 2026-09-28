/** 构建信息（正式版本 / 构建版本）的纯逻辑部分。 */
export function runBuildInfoTests(ok, api) {
  ok(typeof api.BUILD_INFO === 'object', 'BUILD_INFO 在非注入环境也有兜底对象')
  ok(
    api.BUILD_INFO.version === '' && api.BUILD_INFO.buildTime === '',
    '未注入时不编造版本与时间（测试进程就是这种情况）'
  )
  ok(api.BUILD_INFO.repositoryUrl === '', '未注入时仓库地址为空串（不编造链接）')

  /*
   * 仓库地址归一化：package.json 里写的是 `git+https://…/Inkstone.git`，
   * 而界面上要的是能点的网页地址 —— 差一个字符就是一个打不开的链接。
   */
  ok(
    api.normalizeRepositoryUrl('git+https://github.com/Yu-DaTouX/Inkstone.git') ===
      'https://github.com/Yu-DaTouX/Inkstone',
    '归一化 repository.url（去 git+ 前缀与 .git 尾巴）'
  )
  ok(
    api.normalizeRepositoryUrl('https://github.com/Yu-DaTouX/Inkstone#readme') ===
      'https://github.com/Yu-DaTouX/Inkstone',
    '归一化 homepage（去 #readme 片段）'
  )
  ok(
    api.normalizeRepositoryUrl('  https://github.com/o/r/  ') === 'https://github.com/o/r',
    '去掉首尾空白与结尾斜杠'
  )
  ok(
    api.normalizeRepositoryUrl(undefined) === '' && api.normalizeRepositoryUrl('') === '',
    '缺失时返回空串（界面自己决定显示 —）'
  )

  const iso = '2026-09-16T01:06:23.000Z'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`

  ok(api.formatBuildTime(iso) === expected, '构建时间按**本地时间**格式化（用 Date 字段比对，时区无关）')
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(api.formatBuildTime(iso)), '格式为 YYYY-MM-DD HH:mm:ss')

  ok(api.formatBuildTime('') === '', '空值返回空串（界面自己决定显示 —）')
  ok(api.formatBuildTime('not-a-date') === 'not-a-date', '非法值原样返回，不抛错也不显示 NaN')
}
