/*
 * 审查目录宽度单测（src/shared/review-layout.ts，实施-22 R1）。
 * 重点：任何输入下 diff 都留得住最小可读宽度；坏持久化值不把目录弄没。
 */

export async function runReviewLayoutTests(ok, mod) {
  const {
    clampReviewSideWidth,
    defaultReviewSideWidth,
    normalizeReviewSidePrefs,
    REVIEW_SIDE_MIN,
    REVIEW_SIDE_MAX,
    REVIEW_DIFF_MIN
  } = mod

  /* ── 夹取 ── */
  ok(clampReviewSideWidth(900, 200) === 200, '宽面板：想要的宽度直接可用')
  ok(clampReviewSideWidth(900, 10) === REVIEW_SIDE_MIN, '低于最小宽度时抬到最小值')
  ok(clampReviewSideWidth(900, 9999) === REVIEW_SIDE_MAX, '高于最大宽度时压到最大值')
  ok(
    clampReviewSideWidth(600, 9999) === Math.min(REVIEW_SIDE_MAX, 600 - REVIEW_DIFF_MIN),
    '中等面板：上限受 diff 最小可读宽度约束'
  )
  ok(clampReviewSideWidth(400, 9999) === REVIEW_SIDE_MIN, '很窄的面板：目录压到最小值，把宽度留给 diff')
  ok(clampReviewSideWidth(0, 300) === REVIEW_SIDE_MIN, '拿不到面板宽度时给最小值（不返回 0）')
  ok(clampReviewSideWidth(Number.NaN, 300) === REVIEW_SIDE_MIN, '面板宽度非法时给最小值')
  ok(clampReviewSideWidth(900, Number.NaN) === REVIEW_SIDE_MIN, '想要的宽度非法时给最小值')
  ok(clampReviewSideWidth(900, 200.6) === 201, '宽度取整（不留下半个像素）')
  ok(
    clampReviewSideWidth(900, 400) + REVIEW_DIFF_MIN <= 900,
    '任意结果都保证 diff 至少 REVIEW_DIFF_MIN 宽'
  )

  /* ── 默认宽度 ── */
  ok(defaultReviewSideWidth(900) === 252, '默认取面板宽度的 28%')
  ok(defaultReviewSideWidth(1000) === 280, '默认宽度受最大宽度约束')
  ok(defaultReviewSideWidth(400) === REVIEW_SIDE_MIN, '窄面板默认目录也是最小值')

  /* ── 持久化解析 ── */
  const d = normalizeReviewSidePrefs(undefined)
  ok(d.width === null && d.open === true, '没有存过：默认宽度 + 展开')
  ok(normalizeReviewSidePrefs({ width: 240, open: false }).open === false, '读得回收起状态')
  ok(normalizeReviewSidePrefs({ width: 0 }).width === null, '宽度 0 视为没设过（不把目录压成 0）')
  ok(normalizeReviewSidePrefs({ width: -5 }).width === null, '负宽度视为没设过')
  ok(normalizeReviewSidePrefs({ width: '300' }).width === null, '字符串宽度不当数字用')
  ok(normalizeReviewSidePrefs({ width: 240.7 }).width === 241, '宽度取整')
  ok(normalizeReviewSidePrefs('坏的').open === true, '坏数据退回展开（内容不会凭空消失）')
  ok(normalizeReviewSidePrefs({ open: 'no' }).open === true, 'open 不是 false 就当展开')
}

export default runReviewLayoutTests
