/**
 * 浏览器动作的风险策略。
 *
 * 只做一件保守的事：把「点/按一个明显会引发副作用的东西」拦下来，
 * 让模型先调 `browser_request_user_control` 交给用户。
 * 它不是安全边界（真正的边界是 loopback token + 不暴露任意 JS），
 * 只是一道防手滑的提示。
 */
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
