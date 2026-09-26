/**
 * 按需获取能力（实施-25 P17）—— 场景匹配 / 场景化路径 / 「认不出不编」。
 *
 * 三条最值得钉住的：
 *   · **只给路径，不代装**：输出里出现的是可执行的命令顺序，而不是「已安装」；
 *   · **认不出不猜包名**：返回 null 时给通用三步；
 *   · **已有能力就不该当成缺口**（`gapStillMissing`）。
 */

export function runCapabilityGapTests(ok, mod) {
  const { CAPABILITY_GAPS, GAP_ROUTES, GAP_ROUTE_LABELS, matchGap, gapText, unmatchedGapText, gapStillMissing, gapSummary, availableHintsFor } = mod

  /* ---- 场景清单本身 ---- */
  {
    ok(CAPABILITY_GAPS.length >= 8, '场景清单有足够的第一批场景', String(CAPABILITY_GAPS.length))
    const ids = CAPABILITY_GAPS.map((g) => g.id)
    ok(new Set(ids).size === ids.length, '场景 id 不重复')
    ok(
      CAPABILITY_GAPS.every((g) => g.keywords.length > 0 && g.paths.length > 0 && g.missing.trim() && GAP_ROUTES.includes(g.via)),
      '每个场景都有匹配词、路径、缺口说明与来源分类'
    )
    ok(
      CAPABILITY_GAPS.every((g) => g.paths.some((p) => p.command)),
      '每个场景至少给一条可执行的命令（不是纯口头说明）'
    )
    ok(
      CAPABILITY_GAPS.filter((g) => g.via === 'model').length >= 1,
      '有「模型本身就能做 / 取决于模型」这一类（不是所有缺口都能装出来）'
    )
    const scheduled = CAPABILITY_GAPS.find((g) => g.id === 'scheduled')
    ok(!!scheduled && /故意不做/.test(scheduled.missing), '「定时后台」明确写成砚**故意不做**的事')
    ok(/持续关注/.test(gapText(scheduled)), '定时需求被引到「持续关注」而不是承诺做后台任务')
  }

  /* ---- 匹配 ---- */
  {
    const pdf = matchGap('我要把 PDF 里的表格做成汇总')
    ok(!!pdf && pdf.gap.id === 'pdf-tables', '中文需求命中 PDF / 表格场景', pdf?.gap.id)
    ok(!!pdf && pdf.matched.includes('pdf') && pdf.matched.includes('表格'), '命中词如实回报', JSON.stringify(pdf?.matched))
    ok(matchGap('summarise the CSV data')?.gap.id === 'spreadsheet', '英文关键词也认（大小写不敏感）')
    ok(matchGap('爬一个网站的内容')?.gap.id === 'web-page', '抓取网页命中浏览器场景')
    ok(matchGap('把录音转成文字')?.gap.id === 'audio', '转写命中音频场景')
    ok(matchGap('') === null && matchGap('   ') === null, '空需求不匹配')
    ok(matchGap('今天天气怎么样') === null, '与能力无关的问题：不硬塞场景（认不出就交回去）')

    const multi = matchGap('把 PDF 里的表格和图表都统计一下')
    ok(!!multi && multi.matched.length >= 2, '多个词命中时取命中更多的那个', JSON.stringify(multi?.matched))
  }

  /* ---- 文案 ---- */
  {
    const gap = matchGap('我要读 PDF 里的表格').gap
    const text = gapText(gap, ['pdf'])
    ok(/你问的是：/.test(text) && /缺的能力：/.test(text), '文案先说「你问什么、缺什么」')
    ok(/yan capabilities search --query-text/.test(text), '给的第一条命令是 search')
    ok(/yan capabilities prepare --candidate/.test(text) && /yan capabilities acquire --candidate/.test(text), '接着给出 prepare → acquire')
    ok(/yan capabilities discover/.test(text), '本地没有时给联网 discover')
    ok(/装东西会动你本机/.test(text) && /不会自己装/.test(text), '文案说清「装是你的事、砚不代装」')
    ok(!/已(为你)?安装|已接入/.test(text), '文案里没有「已安装」这种承诺', text)

    const generic = unmatchedGapText('把两台打印机连起来')
    ok(/你要做的是：把两台打印机连起来/.test(generic), '通用文案复述需求')
    ok(/不猜该装什么/.test(generic), '明说「不猜该装什么」')
    ok(/capabilities search/.test(generic) && /capabilities discover/.test(generic), '通用文案给三步命令')
    ok(/把两台打印机连起来/.test(generic), '命令里的占位换成用户的话')
    ok(!/npm install|pip install/.test(generic), '不编具体安装命令')
  }

  /* ---- 已有能力就不算缺口 ---- */
  {
    const gap = matchGap('打开一个网页读正文').gap
    ok(gapStillMissing(gap, []) === true, '没有可用清单时按「还缺」处理（宁可多给路径）')
    ok(gapStillMissing(gap, ['builtin:browser.open']) === false, '目录里已有浏览器命令：不算缺口')
    ok(gapStillMissing(gap, ['some:unrelated']) === true, '无关能力不算命中')
    const pdf = matchGap('把 PDF 里的表格做成汇总').gap
    ok(gapStillMissing(pdf, ['skill:pdf-tools']) === false, '装上 PDF 技能后不再算缺口')
    ok(/通常来自/.test(gapSummary(pdf)), '一句话摘要说明这类能力通常怎么来')
    ok(Object.keys(GAP_ROUTE_LABELS).length === GAP_ROUTES.length, '每种来源都有标签')
    /* 识别片段用英文 id（用户在中文里说「浏览器」不代表目录里有 browser） */
    ok(availableHintsFor(pdf).includes('pdf'), 'PDF 场景的识别片段里含 pdf')
    ok(CAPABILITY_GAPS.every((g) => availableHintsFor(g).length > 0), '每个场景都登记了「已有能力」的识别片段')
  }
}
