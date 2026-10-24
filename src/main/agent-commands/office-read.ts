import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import { previewOffice } from '../office/office-service'

export async function runOfficeReadCommand(cwd: string, params: Record<string, unknown>): Promise<CapabilityCommandResult> {
  const path = typeof params.path === 'string' ? params.path.trim() : ''
  if (!path) throw new CapabilityCommandError('office_path_required', '缺少 --path')
  const view = await previewOffice(path, cwd)
  if (!view.ok) throw new CapabilityCommandError('office_read_failed', view.error)
  return {
    data: { path, format: view.format, note: view.note, truncated: view.truncated, sections: view.sections },
    summary: {
      kind: 'office-read',
      format: view.format,
      sections: view.sections.length,
      lines: view.sections.reduce((n, section) => n + section.lines.length, 0),
      truncated: view.truncated
    }
  }
}
