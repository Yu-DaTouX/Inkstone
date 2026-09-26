/**
 * 按活动配置模型（实施-25 P18）—— 清洗 / 解析优先级 / 回退 / 边界文案。
 *
 * 四条最值得钉住的：
 *   · 优先级固定：**活动指定 → 默认 → 跟随会话**；
 *   · **回退要如实说**：配置的模型不可用时回退并标 `fellBack`；
 *   · 连回退目标都没有时**不指定模型**（不替用户随便挑一个）；
 *   · **不改变任务身份与学习状态**：这句话是固定文案（`ACTIVITY_MODEL_SCOPE_NOTE`）。
 */

export function runActivityModelTests(ok, mod) {
  const {
    emptyActivityModelConfig,
    sanitizeActivityModelConfig,
    isActivityModelConfigEmpty,
    setActivityModel,
    resolveActivityModel,
    activityModelText,
    activityModelRows,
    activityModelScopeNote,
    ACTIVITY_MODEL_SCOPE_NOTE
  } = mod

  /* ---- 清洗 ---- */
  {
    ok(isActivityModelConfigEmpty(emptyActivityModelConfig()), '空配置就是空')
    ok(isActivityModelConfigEmpty(undefined), '没配过也算空')

    const dirty = sanitizeActivityModelConfig({
      defaultModel: '  deepseek/x  ',
      byActivity: { research: 'a/b', learn: '   ', unknown: 'c/d', compose: 42 }
    })
    ok(dirty.defaultModel === 'deepseek/x', '模型名去空白')
    ok(dirty.byActivity.research === 'a/b', '合法活动保留')
    ok(dirty.byActivity.learn === null, '空串归一成 null（= 跟默认）')
    ok(!('unknown' in dirty.byActivity), '不认识的「活动」丢掉（不让脏键进磁盘）')
    ok(dirty.byActivity.compose === null, '不是字符串的值归一成 null')
    ok(sanitizeActivityModelConfig('nope').byActivity.deepseek === undefined, '整份不是对象：给空配置')
    const long = sanitizeActivityModelConfig({ defaultModel: 'x'.repeat(300) })
    ok(long.defaultModel === null, '超长模型名丢掉（不写进磁盘）')
    ok(!isActivityModelConfigEmpty(dirty), '有内容时不再是空配置')

    const one = setActivityModel(undefined, 'learn', 'probe/model')
    ok(one.byActivity.learn === 'probe/model', '设一个活动的模型')
    ok(setActivityModel(one, 'learn', null).byActivity.learn === null, '传 null 就是恢复成跟默认')
    ok(setActivityModel(one, 'learn', null).byActivity.research === undefined, '改一个活动不影响别的')
    ok(setActivityModel(one, 'research', '  ')?.byActivity.research === null, '空白模型名当没填')
  }

  /* ---- 解析优先级 ---- */
  {
    const config = { defaultModel: 'default/m', byActivity: { research: 'deep/thinker' } }
    const research = resolveActivityModel({ config, activity: 'research', current: 'session/m' })
    ok(research.model === 'deep/thinker' && research.source === 'activity' && !research.fellBack, '活动指定的优先')
    ok(/这个活动指定了用/.test(research.note), '解释说明「活动指定」', research.note)

    const answer = resolveActivityModel({ config, activity: 'answer', current: 'session/m' })
    ok(answer.model === 'default/m' && answer.source === 'default', '没指定的活动用默认模型')

    const noDefault = resolveActivityModel({ config: { byActivity: {} }, activity: 'compose', current: 'session/m' })
    ok(noDefault.model === 'session/m' && noDefault.source === 'current', '都没配就跟随会话当前模型')

    const nothing = resolveActivityModel({ config: undefined, activity: 'organize' })
    ok(nothing.model === null && nothing.source === 'none' && !nothing.fellBack, '没配也没有会话模型：不指定')

    /* 显式写成 null 的项 = 跟默认，而不是「用名叫 null 的模型」 */
    const explicitNull = resolveActivityModel({
      config: { defaultModel: 'default/m', byActivity: { learn: null } },
      activity: 'learn'
    })
    ok(explicitNull.model === 'default/m' && explicitNull.source === 'default', '显式 null 落到默认那一档')
  }

  /* ---- 回退（T18-2） ---- */
  {
    const config = { defaultModel: 'gone/m' }
    const fell = resolveActivityModel({
      config,
      activity: 'answer',
      current: 'session/m',
      available: ['session/m', 'other/m']
    })
    ok(fell.model === 'session/m' && fell.fellBack && fell.source === 'current', '配置的模型不可用：回退到会话当前模型')
    ok(/现在不可用/.test(fell.note) && /已回退/.test(fell.note), '解释里说清「不可用 + 已回退」', fell.note)

    const noTarget = resolveActivityModel({ config, activity: 'answer', available: ['other/m'] })
    ok(noTarget.model === null && noTarget.source === 'none' && noTarget.fellBack, '没有可回退的模型：不指定（不随便挑一个）')
    ok(!/other\/m/.test(noTarget.note), '不会把清单里的第一个当成回退目标', noTarget.note)

    const noCheck = resolveActivityModel({ config, activity: 'answer', current: 'session/m' })
    ok(noCheck.model === 'gone/m' && !noCheck.fellBack, '没给可用清单时不做可用性检查（也就不回退）')

    const activityFell = resolveActivityModel({
      config: { byActivity: { research: 'gone/r' }, defaultModel: 'ok/d' },
      activity: 'research',
      current: 'session/m',
      available: ['session/m', 'ok/d']
    })
    ok(
      activityFell.model === 'session/m' && activityFell.fellBack,
      '活动那一档不可用时回退到会话模型（不偷偷改用默认）',
      activityFell.note
    )
  }

  /* ---- 边界文案（T18-3） ---- */
  {
    ok(/不会新建会话/.test(ACTIVITY_MODEL_SCOPE_NOTE), '边界文案写明「不会新建会话」')
    ok(/不会动课程与学习进度/.test(ACTIVITY_MODEL_SCOPE_NOTE), '边界文案写明「不动课程与学习进度」')
    ok(/不会改当前活动与任务清单/.test(ACTIVITY_MODEL_SCOPE_NOTE), '边界文案写明「不改活动与任务清单」')
    ok(activityModelScopeNote() === ACTIVITY_MODEL_SCOPE_NOTE, '文案只有一个出口')
    const text = activityModelText(resolveActivityModel({ config: { defaultModel: 'a/b' }, activity: 'answer' }))
    ok(/a\/b/.test(text) && /不会新建会话/.test(text), '一句话说明同时带上模型与边界')
  }

  /* ---- 五个活动的视图 ---- */
  {
    const config = { defaultModel: 'default/m', byActivity: { learn: 'learn/m' } }
    const rows = activityModelRows({ config, current: 'session/m' })
    ok(rows.length === 5, '五个活动各一行', String(rows.length))
    ok(
      rows.map((r) => r.activity).join(',') === 'answer,research,compose,organize,learn',
      '行顺序与活动定义一致（设置页顺序稳定）',
      rows.map((r) => r.activity).join(',')
    )
    ok(rows.find((r) => r.activity === 'learn').resolution.model === 'learn/m', 'learn 用活动指定的模型')
    ok(rows.find((r) => r.activity === 'learn').configured === 'learn/m', '行上带原始配置值（界面回显）')
    ok(rows.find((r) => r.activity === 'research').configured === null, '没配的活动 configured 为 null')
    ok(
      rows.every((r) => typeof r.resolution.note === 'string' && r.resolution.note.length > 0),
      '每行都有解释'
    )
  }
}
