/** N02 模型能力三态与模型身份归一化。 */
export function runModelCapabilitiesTests(ok, api) {
  const model = api.normalizeModelInfo({
    id: 'vision-model',
    name: 'Vision model',
    provider: 'example',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 128000,
    maxTokens: 4096
  })
  ok(model?.reasoningStatus === 'unsupported', '明确 reasoning=false 记为 unsupported')
  ok(model?.inputStatus === 'known' && model.input?.includes('image'), '输入模态只采用上游真实字段')
  ok(model?.contextWindowStatus === 'known' && model.contextWindow === 128000, '上下文窗口保留真实能力')
  ok(api.modelKeyOf(model) === 'example/vision-model', '模型身份用 provider/id 稳定组合')

  const unknown = api.normalizeModelInfo({ id: 'legacy', provider: 'example' })
  ok(unknown?.reasoningStatus === 'unknown', '缺失 reasoning 不猜成不支持')
  ok(unknown?.inputStatus === 'unknown', '缺失 input 不猜成文本或图像能力')
  ok(unknown?.contextWindowStatus === 'unknown', '缺失上下文窗口标为未知')

  const noThinking = api.normalizeThinkingLevels([], true)
  const failedThinking = api.normalizeThinkingLevels(undefined, false)
  const thinking = api.normalizeThinkingLevels(['low', 'low', 'high'], true)
  ok(noThinking.status === 'unsupported' && noThinking.values.length === 0, '明确空思考档位与查询失败区分')
  ok(failedThinking.status === 'unknown', '思考档位查询失败标为 unknown')
  ok(thinking.status === 'known' && thinking.values.length === 2, '思考档位去重并保留上游顺序')

  const snapshot = api.capabilitySnapshot(model, noThinking.values, noThinking.status)
  ok(snapshot?.thinkingLevels.status === 'unsupported', '能力快照保留思考档位状态')
  ok(snapshot?.input.status === 'known' && snapshot.input.modalities.includes('image'), '能力快照保留输入模态')

  /*
   * D11 回归网：pi 的 get_state **不返回档位**，所以 state 快照不能把已知档位清掉。
   * 早期实现直接从快照读 availableThinkingLevels，字段永远不存在 → 每条推送都
   * 把档位重置为 unknown，界面一直说“上游未提供思考档位信息”。
   */
  const known = { levels: ['off', 'low', 'high'], status: 'known', modelKey: 'deepseek/deepseek-flash' }

  const kept = api.resolveThinkingLevels({ model: {} }, known, 'deepseek/deepseek-flash')
  ok(
    kept.status === 'known' && kept.values.join(',') === 'off,low,high',
    'get_state 不含档位且模型未变 → 沿用已知档位（不是 unknown）'
  )

  const switched = api.resolveThinkingLevels({ model: {} }, known, 'commandcode/other-model')
  ok(
    switched.status === 'unknown' && switched.values.length === 0,
    '模型变了且快照不含档位 → 先清空为 unknown，等 listThinkingLevels 回填'
  )

  const fromSnapshot = api.resolveThinkingLevels(
    { availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'] },
    known,
    'deepseek/deepseek-flash'
  )
  ok(
    fromSnapshot.status === 'known' && fromSnapshot.values.length === 5,
    '快照里真的有档位字段时以它为准（兼容旧版/未来 pi）'
  )

  const unsupported = api.resolveThinkingLevels(
    { availableThinkingLevels: [] },
    known,
    'deepseek/deepseek-flash'
  )
  ok(unsupported.status === 'unsupported', '空数组是权威结果：模型确实没有可调档位')

  const cold = api.resolveThinkingLevels({ model: {} }, undefined, 'deepseek/deepseek-flash')
  ok(cold.status === 'unknown', '冷启动（还没有已知档位）先标 unknown')
}

