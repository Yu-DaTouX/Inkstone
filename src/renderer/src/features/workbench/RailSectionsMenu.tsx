import type { ReactElement, RefObject } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { Header, Menu, MenuItem, MenuSection, Popover, Separator } from '../../ui'
import {
  canHideRailSection,
  isRailSectionHidden,
  railSectionsAreDefault,
  RAIL_SECTION_IDS,
  useRailSections,
  type RailSectionId
} from './rail-sections'
import type { RailText } from './rail-text'

const HIDEABLE = RAIL_SECTION_IDS.filter(canHideRailSection)

export interface RailSectionsMenuProps {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  text: RailText
}

export function RailSectionsMenu({ anchor, open, onOpenChange, text }: RailSectionsMenuProps): ReactElement {
  const hidden = useRailSections((s) => s.hidden)
  const order = useRailSections((s) => s.order)
  const setHidden = useRailSections((s) => s.setHidden)
  const reset = useRailSections((s) => s.reset)
  const shown = HIDEABLE.filter((id) => !isRailSectionHidden({ hidden }, id))
  const atDefault = railSectionsAreDefault({ order, hidden })

  return (
    <Popover triggerRef={anchor} isOpen={open} onOpenChange={onOpenChange} placement="bottom start" offset={4}>
      <Menu
        aria-label={text.sectionsMenu}
        autoFocus="first"
        disabledKeys={atDefault ? ['reset'] : []}
        onAction={(key) => {
          if (key === 'reset') reset()
          else if (typeof key === 'string' && HIDEABLE.includes(key as RailSectionId)) {
            const id = key as RailSectionId
            setHidden(id, !isRailSectionHidden({ hidden }, id))
          }
        }}
        data-testid="wb-rail-menu"
      >
        <MenuSection aria-label={text.show}>
          <Header>{text.show}</Header>
          {HIDEABLE.map((id) => {
            const visible = shown.includes(id)
            return (
              <MenuItem key={id} id={id} textValue={text.sections[id]} aria-checked={visible} shouldCloseOnSelect={false} data-testid={`wb-rail-menu-${id}`}>
                <span className="wb-rail-check" aria-hidden>{visible ? <Check size={14} /> : null}</span>
                {text.sections[id]}
              </MenuItem>
            )
          })}
        </MenuSection>
        <Separator />
        <MenuItem id="reset" textValue={text.reset} data-testid="wb-rail-menu-reset">
          <RotateCcw size={14} aria-hidden />
          {text.reset}
        </MenuItem>
      </Menu>
    </Popover>
  )
}
