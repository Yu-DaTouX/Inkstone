import { useEffect } from 'react'
import { useStore } from '../../state/store'

export function SubagentNote() {
  const loadSubagents = useStore((s) => s.loadSubagents)
  useEffect(() => {
    void loadSubagents()
  }, [loadSubagents])
  return null
}
