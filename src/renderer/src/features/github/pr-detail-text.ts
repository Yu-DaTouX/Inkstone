import type { Lang } from '../../i18n'
import type { PrReviewerState } from './pr-model'

export interface PrDetailText {
  tabs: { summary: string; timeline: string; code: string }
  tabsLabel: string
  repoLink: (repo: string) => string
  prLink: (n: number) => string
  copyCheckout: string
  copied: string
  files: (n: number) => string
  receives: string
  reviewers: string
  noReviewers: string
  labels: string
  noLabels: string
  description: string
  showDescription: string
  hideDescription: string
  checksSummary: (passed: number, total: number) => string
  checksFailing: (failed: number, total: number) => string
  checksPending: (pending: number, total: number) => string
  noChecks: string
  refresh: string
  merged: (time: string) => string
  closed: (time: string) => string
  commit: string
  reviewer: Record<PrReviewerState, string>
}

const ZH: PrDetailText = {
  tabs: { summary: '概要', timeline: '时间线', code: '代码' },
  tabsLabel: 'Pull 请求分段',
  repoLink: (repo) => `在浏览器打开仓库 ${repo}`,
  prLink: (n) => `在浏览器打开 #${n}`,
  copyCheckout: '复制检出命令',
  copied: '已复制',
  files: (n) => `${n} 个文件`,
  receives: '接收来自',
  reviewers: '审阅者',
  noReviewers: '没有审阅者',
  labels: '标签',
  noLabels: '没有标签',
  description: '描述',
  showDescription: '展开描述',
  hideDescription: '收起描述',
  checksSummary: (passed, total) => `检查 ${passed}/${total} 通过`,
  checksFailing: (failed, total) => `${failed}/${total} 项检查失败`,
  checksPending: (pending, total) => `${pending}/${total} 项检查进行中`,
  noChecks: '没有检查',
  refresh: '刷新',
  merged: (time) => `合并于 ${time}`,
  closed: (time) => `关闭于 ${time}`,
  commit: '提交',
  reviewer: { approved: '已批准', changes: '要求修改', commented: '已评论', pending: '待审阅', dismissed: '已撤销' }
}

const EN: PrDetailText = {
  tabs: { summary: 'Summary', timeline: 'Timeline', code: 'Code' },
  tabsLabel: 'Pull request sections',
  repoLink: (repo) => `Open repository ${repo} in browser`,
  prLink: (n) => `Open #${n} in browser`,
  copyCheckout: 'Copy checkout command',
  copied: 'Copied',
  files: (n) => `${n} ${n === 1 ? 'file' : 'files'}`,
  receives: 'receives changes from',
  reviewers: 'Reviewers',
  noReviewers: 'No reviewers',
  labels: 'Labels',
  noLabels: 'No labels',
  description: 'Description',
  showDescription: 'Show description',
  hideDescription: 'Hide description',
  checksSummary: (passed, total) => `${passed}/${total} checks passed`,
  checksFailing: (failed, total) => `${failed}/${total} checks failing`,
  checksPending: (pending, total) => `${pending}/${total} checks pending`,
  noChecks: 'No checks',
  refresh: 'Refresh',
  merged: (time) => `Merged ${time}`,
  closed: (time) => `Closed ${time}`,
  commit: 'Commit',
  reviewer: { approved: 'Approved', changes: 'Changes requested', commented: 'Commented', pending: 'Pending', dismissed: 'Dismissed' }
}

export function prDetailText(lang: Lang): PrDetailText {
  return lang === 'en-US' ? EN : ZH
}
