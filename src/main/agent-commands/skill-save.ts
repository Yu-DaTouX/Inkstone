import { basename, dirname } from 'node:path'
import { pick } from '../../shared/ui-lang'
import { UI_TIMEOUT_APPROVAL } from '../../shared/ui-timeout'
import { CapabilityCommandError } from '../capability-server'
import { saveUserSkill } from '../user-skills'
import type { HostUiResponse } from '../ui-requests'

export interface SkillSaveHost {
  bundledSkills(): string[]
  requestApproval(request: { title: string; message: string; options: string[]; placeholder: string; timeout: number }): Promise<HostUiResponse>
}

export async function runSkillSave(host: SkillSaveHost, params: Record<string, unknown>) {
  const reservedNames = host.bundledSkills().map((file) => basename(dirname(file)))
  const res = await saveUserSkill(
    {
      name: typeof params.name === 'string' ? params.name : '',
      description: typeof params.description === 'string' ? params.description : '',
      body: typeof params.body === 'string' ? params.body : '',
      replace: params.replace === true || params.replace === 'true'
    },
    {
      reservedNames,
      confirm: async ({ name, description, body, replaced }) => {
        const option = replaced ? pick('覆盖', 'Overwrite') : pick('保存到我的技能', 'Save to My skills')
        try {
          const answer = await host.requestApproval({
            title: replaced ? pick(`覆盖技能「${name}」`, `Overwrite skill "${name}"`) : pick(`保存技能「${name}」`, `Save skill "${name}"`),
            message: [description, body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body].join('\n\n'),
            options: [option],
            placeholder: pick('或告诉 Agent 换个做法（不保存）', 'Or tell the Agent to do it another way (no save)'),
            timeout: UI_TIMEOUT_APPROVAL
          })
          if (answer.value === option) return { ok: true }
          const reply = answer.cancelled ? undefined : answer.value?.trim() || undefined
          return { ok: false, ...(reply ? { reply } : {}) }
        } catch (error) {
          if (!(error instanceof CapabilityCommandError) || error.code !== 'question_timeout') throw error
          return { ok: false, timedOut: true }
        }
      }
    }
  )
  if (!res.ok) throw new CapabilityCommandError(`skill_${res.code.replace(/-/g, '_')}`, res.error)
  return {
    data: { name: res.name, path: res.path, replaced: res.replaced },
    summary: {
      kind: 'skill',
      action: 'save',
      name: res.name,
      replaced: res.replaced,
      note: '已保存；新会话启动时加载，之后可用 yan skill read --id skill:' + res.name + ' 读取'
    }
  }
}
