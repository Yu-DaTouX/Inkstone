export const INKSTONE_SECTION_ORDER = [
  'inkstone_work',
  'inkstone_question',
  'inkstone_report',
  'inkstone_visual_answer',
  'inkstone_response_detail',
  'inkstone_capabilities',
  'inkstone_computer_use',
  'inkstone_hosted_mcp',
  'inkstone_session_skills',
  'inkstone_environment',
  'inkstone_language',
  'inkstone_user_address'
]

export function reserveInkstoneSections(sections) {
  if (!sections || typeof sections !== 'object') return
  for (const name of INKSTONE_SECTION_ORDER) if (!(name in sections)) sections[name] = ''
}
