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
}

