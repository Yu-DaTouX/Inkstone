import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { CONTEXT_POLICY_PRESETS } from '../../../../shared/context-policy'
import type { ContextPolicyOverrides } from '../../../../shared/ipc'

/**
 * 「上下文」设置页（N21-7）。
 *
 * 把此前只存在于代码里的工作集数值变成用户可改、可解释的一组值：
 *   · **预设**：砚默认（已验证的 240k / 70%）与参考方案（300k / 75%）；
 *   · **用户级**：三个数值覆盖（留空 = 用默认）；
 *   · **模型级**：只为当前模型覆盖（`provider/model`），切模型各用各的；
 *   · **生效来源**：显示这份数值是哪一层定的（默认 / 用户 / 供应商 / 模型 / 环境变量）。
 *
 * 为什么只暴露三个字段：它们是参考方案 §16.4 明确要求 profile 化的三个
 * （`workingSetCap` / `workingSetRatio` / `responseReserve`），也是真正会影响
 * “什么时候动手”的三个。其余字段（安全余量、兜底比例、阶段刻度）仍可在
 * `desktop.json` 里手写，但界面上不给 —— 一排数字里挑错一个的代价太大，
 * 而它们极少需要改。
 *
 * 为什么草稿 + 显式保存而不是每键写盘：数值输入中间态（例如刚删成空串）
 * 不是合法设置，逐键 patchSettings 会写进一堆半成品，同时每键一次 IPC。
 */
export function ContextTab() {
  const t = useT()
  /* 生效层 / 字段名是运行期拼出来的 key（`set.ctxSource.model` 这类），
     而 i18n 的 key 是编译期联合类型 —— 这里集中断言一次，不要每处都写。 */
  const tk = (key: string): string => t(key as MessageKey)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const policy = useStore((s) => s.session?.contextPolicy)
  const model = useStore((s) => s.session?.model)

  const user = settings?.contextPolicy ?? {}
  const byModel = settings?.contextPolicyByModel ?? {}
  const modelKey = model?.provider && model.id ? `${model.provider}/${model.id}` : undefined
  const modelOver = modelKey ? byModel[modelKey] : undefined

  const [draft, setDraft] = useState(() => fields(user))
  const [modelDraft, setModelDraft] = useState(() => fields(modelOver))
  /* 设置从别处变了（预设按钮 / 另一个窗口）要跟上，否则输入框显示旧值 */
  useEffect(() => setDraft(fields(settings?.contextPolicy)), [settings?.contextPolicy])
  useEffect(() => setModelDraft(fields(modelOver)), [modelKey, JSON.stringify(modelOver ?? null)])

  const saveUser = (): void => {
    void patchSettings({ contextPolicy: overridesFrom(draft) })
  }
  const saveModel = (): void => {
    if (!modelKey) return
    const next = { ...byModel }
    const o = overridesFrom(modelDraft)
    if (o) next[modelKey] = o
    else delete next[modelKey]
    void patchSettings({ contextPolicyByModel: next })
  }
  const removeModel = (key: string): void => {
    const next = { ...byModel }
    delete next[key]
    void patchSettings({ contextPolicyByModel: next })
  }

  const otherKeys = Object.keys(byModel).filter((k) => k !== modelKey)
  const currentPreset = presetOf(user)

  return (
    <div className="set-group">
      {/* 生效来源：这一块的全部意义就是“让人相信界面上的数就是真正在用的数” */}
      <div className="set-row col">
        <div className="set-label">
          <div className="set-name">{t('set.ctxSource')}</div>
          <div className="set-desc" data-testid="ctx-source">
            {policy
              ? `${tk(`set.ctxSource.${policy.source}`)}${
                  policy.sourceKey ? ` · ${policy.sourceKey}` : ''
                } · ${t('set.ctxWorkingSet', { n: policy.budget.workingSet.toLocaleString('en-US') })}`
              : t('set.ctxSource.off')}
          </div>
          <div className="set-desc set-num">
            {policy && policy.overridden.length
              ? t('set.ctxOverridden', { fields: policy.overridden.map((f) => tk(`set.ctxField.${f}`)).join(' / ') })
              : t('set.ctxAllDefault')}
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.ctxPreset')}</div>
          <div className="set-desc">{t('set.ctxPresetDesc')}</div>
        </div>
        <div className="set-ctl seg" data-testid="ctx-preset">
          {(['default', 'reference'] as const).map((p) => (
            <button
              key={p}
              className={`seg-btn ${currentPreset === p ? 'sel' : ''}`}
              data-preset={p}
              onClick={() => void patchSettings({ contextPolicy: presetOverrides(p) })}
            >
              {tk(`set.ctxPreset.${p}`)}
            </button>
          ))}
        </div>
      </div>

      <NumRow
        label={t('set.ctxCap')}
        desc={t('set.ctxCapDesc')}
        testid="ctx-cap"
        value={draft.cap}
        onChange={(v) => setDraft({ ...draft, cap: v })}
      />
      <NumRow
        label={t('set.ctxRatio')}
        desc={t('set.ctxRatioDesc')}
        testid="ctx-ratio"
        value={draft.ratio}
        onChange={(v) => setDraft({ ...draft, ratio: v })}
      />
      <NumRow
        label={t('set.ctxReserve')}
        desc={t('set.ctxReserveDesc')}
        testid="ctx-reserve"
        value={draft.reserve}
        onChange={(v) => setDraft({ ...draft, reserve: v })}
      />

      <div className="set-row">
        <div className="set-label">
          <div className="set-desc">{t('set.ctxHint')}</div>
        </div>
        <div className="set-ctl seg">
          <button className="seg-btn" data-testid="ctx-save" onClick={saveUser}>
            {t('set.ctxSave')}
          </button>
          <button
            className="seg-btn"
            data-testid="ctx-reset"
            onClick={() => {
              setDraft(fields(undefined))
              void patchSettings({ contextPolicy: undefined })
            }}
          >
            {t('set.ctxReset')}
          </button>
        </div>
      </div>

      {/* ---- 模型级覆盖 ---- */}
      <div className="set-row col">
        <div className="set-label">
          <div className="set-name">{t('set.ctxModel')}</div>
          <div className="set-desc">
            {modelKey ? t('set.ctxModelDesc', { model: modelKey }) : t('set.ctxModelNoModel')}
          </div>
        </div>
      </div>

      {modelKey ? (
        <>
          <NumRow
            label={t('set.ctxCap')}
            desc={t('set.ctxCapDesc')}
            testid="ctx-model-cap"
            value={modelDraft.cap}
            onChange={(v) => setModelDraft({ ...modelDraft, cap: v })}
          />
          <NumRow
            label={t('set.ctxRatio')}
            desc={t('set.ctxRatioDesc')}
            testid="ctx-model-ratio"
            value={modelDraft.ratio}
            onChange={(v) => setModelDraft({ ...modelDraft, ratio: v })}
          />
          <div className="set-row">
            <div className="set-label">
              <div className="set-desc">{t('set.ctxModelHint')}</div>
            </div>
            <div className="set-ctl seg">
              <button className="seg-btn" data-testid="ctx-model-save" onClick={saveModel}>
                {modelOver ? t('set.ctxModelUpdate') : t('set.ctxModelAdd')}
              </button>
              {modelOver ? (
                <button
                  className="seg-btn"
                  data-testid="ctx-model-remove"
                  onClick={() => {
                    setModelDraft(fields(undefined))
                    removeModel(modelKey)
                  }}
                >
                  {t('set.ctxModelRemove')}
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {otherKeys.length ? (
        <div className="set-row col">
          <div className="set-label">
            <div className="set-name">{t('set.ctxModelOthers')}</div>
            {otherKeys.map((k) => (
              <div className="set-desc set-num" key={k} data-testid="ctx-model-other">
                {k} · {summary(byModel[k])}
                <button className="ctx-link" onClick={() => removeModel(k)}>
                  {t('set.ctxModelRemove')}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ 小组件 */

/** 数值输入行（留空 = 用默认值） */
function NumRow({
  label,
  desc,
  value,
  onChange,
  testid
}: {
  label: string
  desc: string
  value: string
  onChange: (v: string) => void
  testid: string
}) {
  return (
    <div className="set-row">
      <div className="set-label">
        <div className="set-name">{label}</div>
        <div className="set-desc">{desc}</div>
      </div>
      <div className="set-ctl">
        <input
          className="set-input"
          type="number"
          inputMode="numeric"
          data-testid={testid}
          value={value}
          placeholder="—"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 纯逻辑 */

interface Fields {
  cap: string
  ratio: string
  reserve: string
}

function fields(o: ContextPolicyOverrides | undefined): Fields {
  return {
    cap: o?.workingSetCap === undefined ? '' : String(o.workingSetCap),
    ratio: o?.windowRatio === undefined ? '' : String(o.windowRatio),
    reserve: o?.responseReservePreferred === undefined ? '' : String(o.responseReservePreferred)
  }
}

/** 草稿 → 覆盖对象；三个字段都空时返回 undefined（= 没有覆盖） */
function overridesFrom(d: Fields): ContextPolicyOverrides | undefined {
  const out: ContextPolicyOverrides = {}
  const num = (v: string): number | undefined => {
    const s = v.trim()
    if (!s) return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  const cap = num(d.cap)
  if (cap !== undefined) out.workingSetCap = cap
  const ratio = num(d.ratio)
  if (ratio !== undefined) out.windowRatio = ratio
  const reserve = num(d.reserve)
  if (reserve !== undefined) out.responseReservePreferred = reserve
  return Object.keys(out).length ? out : undefined
}

function presetOverrides(p: 'default' | 'reference'): ContextPolicyOverrides | undefined {
  const o = CONTEXT_POLICY_PRESETS[p]
  return Object.keys(o).length ? { ...o } : undefined
}

/** 当前用户级覆盖命中了哪个预设（都不命中时 undefined —— 界面就不亮任何一项） */
function presetOf(o: ContextPolicyOverrides): 'default' | 'reference' | undefined {
  if (!Object.keys(o).length) return 'default'
  const ref = CONTEXT_POLICY_PRESETS.reference
  const keys = Object.keys(o)
  const sameRef =
    keys.length === 2 &&
    o.workingSetCap === ref.workingSetCap &&
    o.windowRatio === ref.windowRatio
  return sameRef ? 'reference' : undefined
}

function summary(o: ContextPolicyOverrides): string {
  const parts: string[] = []
  if (o.workingSetCap !== undefined) parts.push(`cap ${o.workingSetCap}`)
  if (o.windowRatio !== undefined) parts.push(`ratio ${o.windowRatio}`)
  if (o.responseReservePreferred !== undefined) parts.push(`reserve ${o.responseReservePreferred}`)
  return parts.join(' · ') || '—'
}
