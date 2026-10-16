const HIGH_RISK = /\b(delete|remove|buy|purchase|pay|checkout|send|submit|authorize|grant|revoke|publish|post)\b|删除|购买|支付|付款|提交|发送|授权|发布/i

export class BrowserPolicy {
  checkAction(name: string, target = ''): { ok: true } | { ok: false; code: string; message: string } {
    if (HIGH_RISK.test(`${name} ${target}`)) {
      return {
        ok: false,
        code: 'USER_CONFIRMATION_REQUIRED',
        message: '这是高风险浏览器动作，请先调用 browser_request_user_control 让用户接管页面。'
      }
    }
    return { ok: true }
  }
}
