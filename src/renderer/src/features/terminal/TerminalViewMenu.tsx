import type { JSX } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { IconButton, Menu, MenuItem, MenuTrigger, Popover, SubmenuTrigger } from '../../ui'
import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZES,
  TERMINAL_LINE_HEIGHTS,
  TERMINAL_SCROLLBACKS,
  type TerminalViewSettings
} from './terminal-view'
import type { TerminalText } from './terminal-text'

export interface TerminalViewMenuProps {
  view: TerminalViewSettings
  text: TerminalText
  onChange: (patch: Partial<TerminalViewSettings>) => void
}

export function TerminalViewMenu({ view, text, onChange }: TerminalViewMenuProps): JSX.Element {
  const cursorLabel = {
    block: text.cursorBlock,
    bar: text.cursorBar,
    underline: text.cursorUnderline
  }
  const lineHeightLabel = (value: number): string => String(value)
  return (
    <MenuTrigger>
      <IconButton size="sm" aria-label={text.viewMenu} tooltip={text.viewMenu} data-testid="terminal-view-menu">
        <SlidersHorizontal size={14} aria-hidden />
      </IconButton>
      <Popover placement="bottom end" offset={4}>
        <Menu aria-label={text.viewMenu} autoFocus="first">
          <SubmenuTrigger>
            <MenuItem id="font-size" textValue={text.fontSize}>
              {text.fontSize}
              <span className="term-view-hint">{String(view.fontSize)}</span>
            </MenuItem>
            <Popover placement="end top" offset={2}>
              <Menu aria-label={text.fontSize} onAction={(key) => onChange({ fontSize: Number(key) })}>
                {TERMINAL_FONT_SIZES.map((size) => (
                  <MenuItem key={size} id={String(size)} textValue={String(size)} checked={view.fontSize === size}>
                    {String(size)}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </SubmenuTrigger>
          <SubmenuTrigger>
            <MenuItem id="line-height" textValue={text.lineHeight}>
              {text.lineHeight}
              <span className="term-view-hint">{lineHeightLabel(view.lineHeight)}</span>
            </MenuItem>
            <Popover placement="end top" offset={2}>
              <Menu aria-label={text.lineHeight} onAction={(key) => onChange({ lineHeight: Number(key) })}>
                {TERMINAL_LINE_HEIGHTS.map((height) => (
                  <MenuItem key={height} id={String(height)} textValue={lineHeightLabel(height)} checked={view.lineHeight === height}>
                    {lineHeightLabel(height)}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </SubmenuTrigger>
          <SubmenuTrigger>
            <MenuItem id="cursor-style" textValue={text.cursorStyle}>
              {text.cursorStyle}
              <span className="term-view-hint">{cursorLabel[view.cursorStyle]}</span>
            </MenuItem>
            <Popover placement="end top" offset={2}>
              <Menu aria-label={text.cursorStyle} onAction={(key) => onChange({ cursorStyle: String(key) as TerminalViewSettings['cursorStyle'] })}>
                {TERMINAL_CURSOR_STYLES.map((style) => (
                  <MenuItem key={style} id={style} textValue={cursorLabel[style]} checked={view.cursorStyle === style}>
                    {cursorLabel[style]}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </SubmenuTrigger>
          <MenuItem id="cursor-blink" textValue={text.cursorBlink} checked={view.cursorBlink} onAction={() => onChange({ cursorBlink: !view.cursorBlink })}>
            {text.cursorBlink}
          </MenuItem>
          <SubmenuTrigger>
            <MenuItem id="scrollback" textValue={text.scrollback}>
              {text.scrollback}
              <span className="term-view-hint">{text.lines(view.scrollback)}</span>
            </MenuItem>
            <Popover placement="end top" offset={2}>
              <Menu aria-label={text.scrollback} onAction={(key) => onChange({ scrollback: Number(key) })}>
                {TERMINAL_SCROLLBACKS.map((value) => (
                  <MenuItem key={value} id={String(value)} textValue={text.lines(value)} checked={view.scrollback === value}>
                    {text.lines(value)}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </SubmenuTrigger>
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
