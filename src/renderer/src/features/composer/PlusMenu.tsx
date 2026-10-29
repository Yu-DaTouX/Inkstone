import { useState } from 'react'
import { Menu, MenuItem, MenuTrigger, Separator } from 'react-aria-components'
import { AtSign, Bot, FileText, Image as ImageIcon, Mic, Slash, Terminal } from 'lucide-react'
import { IconButton, Popover } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { DelegateDialog } from './DelegateDialog'
import { StashMenuItem, StashSaveMenuItem } from './StashMenu'

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
        <span className="composer-plus-glyph" aria-hidden>＋</span>
      </IconButton>
      <Popover className="composer-plus-pop" placement="top end" offset={6}>
        <Menu className="composer-plus-menu" data-testid="composer-plus-menu">
          <MenuItem className="cpm-item" textValue={t('plus.files')} onAction={() => void pickFiles()}>
            <FileText size={14} aria-hidden />
            <span className="cpm-label">{t('plus.files')}</span>
            <span className="cpm-hint">{t('plus.filesHint')}</span>
          </MenuItem>
          <MenuItem className="cpm-item" textValue={t('plus.images')} onAction={() => void pickImages()}>
            <ImageIcon size={14} aria-hidden />
            <span className="cpm-label">{t('plus.images')}</span>
            <span className="cpm-hint">{t('plus.imagesHint')}</span>
          </MenuItem>
          <Separator className="cpm-sep" />
          <MenuItem className="cpm-item" textValue={t('composer.mention')} onAction={() => onInsert('@')}>
            <AtSign size={14} aria-hidden />
            <span className="cpm-label">{t('composer.mention')}</span>
          </MenuItem>
          <MenuItem className="cpm-item" textValue={t('composer.cmdMode')} onAction={() => onInsert('/')}>
            <Slash size={14} aria-hidden />
            <span className="cpm-label">{t('composer.cmdMode')}</span>
          </MenuItem>
          <MenuItem className="cpm-item" textValue={t('composer.run')} onAction={() => onInsert('!')}>
            <Terminal size={14} aria-hidden />
            <span className="cpm-label">{t('composer.run')}</span>
            <span className="cpm-hint">{t('composer.bashMode')}</span>
          </MenuItem>
          <MenuItem className="cpm-item" textValue={t('set.voice')} onAction={() => openSettings('voice')}>
            <Mic size={14} aria-hidden />
            <span className="cpm-label">{t('set.voice')}</span>
          </MenuItem>
          <Separator className="cpm-sep" />
          <StashSaveMenuItem />
          <StashMenuItem />
          <Separator className="cpm-sep" />
          <MenuItem
            className="cpm-item"
            textValue={t('delegate.start')}
            isDisabled={peeking}
            onAction={() => setDelegateOpen(true)}
            data-testid="composer-plus-delegate"
          >
            <Bot size={14} aria-hidden />
            <span className="cpm-label">{t('hub.title')}</span>
            <span className="cpm-hint">{t('delegate.start')}</span>
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
    <DelegateDialog isOpen={delegateOpen} onOpenChange={setDelegateOpen} />
    </>
  )
}
