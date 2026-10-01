import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'

/** 失败提示：分类 + 原文。原文可以折叠，但它才是排查的第一现场 */
export function WriteFailure({ msg, hint, detail }: { msg: string; hint?: string; detail?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="gwrite-fail" data-testid="git-failure" role="alert">
      <div className="gwrite-fail-line">
        <Icon name="alert-circle" size={12} />
        <span className="gwrite-fail-msg">{msg}</span>
      </div>
      {hint ? <div className="gwrite-fail-hint">{hint}</div> : null}
      {detail ? (
        <>
          <button
            type="button"
            className="gwrite-fail-more"
            data-testid="git-failure-detail-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t('git.hideRaw') : t('git.showRaw')}
          </button>
          {open ? <pre className="gwrite-fail-raw">{detail}</pre> : null}
        </>
      ) : null}
    </div>
  )
}
