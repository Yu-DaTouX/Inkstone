import { CapabilityCommandError } from '../capability-server'
import { readSkillById, type RawSkillCommand } from '../capabilities/skill-service'
import { paramString } from '../command-params'

export interface SkillReadHost {
  rawCommands(): Promise<RawSkillCommand[]>
}

export async function runSkillRead(host: SkillReadHost, params: Record<string, unknown>) {
  const id = paramString(params, ['id', 'skillId', 'skill-id'])
  if (!id) {
    throw new CapabilityCommandError('skill_id_required', 'skill read 需要 --id <技能ID>（形如 skill:<名称>）')
  }
  const commands = await host.rawCommands()
  try {
    const skill = await readSkillById(commands, id)
    return {
      data: skill,
      summary: {
        kind: 'skill',
        action: 'read',
        id: skill.id,
        name: skill.name,
        contentHash: skill.contentHash,
        bytes: Buffer.byteLength(skill.body, 'utf8')
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CapabilityCommandError('skill_unavailable', message)
  }
}
