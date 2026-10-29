import { useState } from 'react'
import { AtSign, Bot, FileText, Image as ImageIcon, Mic, Plus, Slash, Terminal } from 'lucide-react'
import { IconButton, Menu, MenuItem, MenuSeparator, MenuTrigger, Popover } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { DelegateDialog } from './DelegateDialog'
import { StashMenuItem, StashSaveMenuItem } from './StashMenu'

const ICON = 14

export function PlusMenu({ onInsert }: { onInsert: (text: string) => void }) {
  const t = useT()
  const pickImages = useStore((s) => s.pickImages)
  const pickFiles = useStore((s) => s.pickFiles)
  const openSettings = useStore((s) => s.openSettings)
  const peeking = useStore((s) => !!s.peekedSessionId)
  const [delegateOpen, setDelegateOpen] = useState(false)

  return (
    <>
      <MenuTrigger>
        <IconButton aria-label={t('composer.attach')} className="composer-plus" data-testid="composer-plus">
          <Plus size={16} aria-hidden />
        </IconButton>
        <Popover className="composer-plus-pop" placement="top end" offset={6}>
          <Menu className="composer-plus-menu" data-testid="composer-plus-menu">
            <MenuItem
              textValue={t('plus.files')}
              icon={<FileText size={ICON} />}
              description={t('plus.filesHint')}
              onAction={() => void pickFiles()}
            >
              {t('plus.files')}
            </MenuItem>
            <MenuItem
              textValue={t('plus.images')}
              icon={<ImageIcon size={ICON} />}
              description={t('plus.imagesHint')}
              onAction={() => void pickImages()}
            >
              {t('plus.images')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem textValue={t('composer.mention')} icon={<AtSign size={ICON} />} onAction={() => onInsert('@')}>
              {t('composer.mention')}
            </MenuItem>
            <MenuItem textValue={t('composer.cmdMode')} icon={<Slash size={ICON} />} onAction={() => onInsert('/')}>
              {t('composer.cmdMode')}
            </MenuItem>
            <MenuItem
              textValue={t('composer.run')}
              icon={<Terminal size={ICON} />}
              description={t('composer.bashMode')}
              onAction={() => onInsert('!')}
            >
              {t('composer.run')}
            </MenuItem>
            <MenuItem textValue={t('set.voice')} icon={<Mic size={ICON} />} onAction={() => openSettings('voice')}>
              {t('set.voice')}
            </MenuItem>
            <MenuSeparator />
            <StashSaveMenuItem />
            <StashMenuItem />
            <MenuSeparator />
            <MenuItem
              textValue={t('delegate.start')}
              icon={<Bot size={ICON} />}
              description={t('delegate.start')}
              isDisabled={peeking}
              onAction={() => setDelegateOpen(true)}
              data-testid="composer-plus-delegate"
            >
              {t('hub.title')}
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      <DelegateDialog isOpen={delegateOpen} onOpenChange={setDelegateOpen} />
    </>
  )
}
