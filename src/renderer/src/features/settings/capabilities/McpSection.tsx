import type { ReactElement } from 'react'
import { McpAppRefresh } from './McpAppRefresh'
import { McpServices } from './McpServices'

export function McpSection(): ReactElement {
  return <McpServices advanced={<McpAppRefresh />} />
}
