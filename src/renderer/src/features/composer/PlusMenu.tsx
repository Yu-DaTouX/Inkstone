import { useState } from 'react'
import { Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components'
import { AtSign, Bot, FileText, Image as ImageIcon, Mic, Slash, Terminal } from 'lucide-react'
import { IconButton } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { DelegateDialog } from './DelegateDialog'

/**
 * `＋` 菜单（WP-24，方案 §8.7）：把低频入口收进一个按钮。
 *
 * 这一版只放**已经有正式动作**的项：
 *   · 文件和文件夹 → `store.pickFiles`（登记路径，模型按需读）
 *   · 图片         → `store.pickImages`（读进上下文）
 *   · `@` 引用     → 在光标处插入 `@`（补全菜单沿用既有查询纯逻辑，后续工位接）
 *   · `/` 命令     → 在光标处插入 `/`
 *   · 运行 shell   → 在光标处插入 `!`
 *   · 语音         → 打开设置的语音页（录音组件属语音工位，不在本工位重造）
 *   · 子 Agent     → 手动派发表单（正式启动链；正在看的不是活动会话时禁用）
 *
 * 「先计划」等没有正式 store 动作的项**不在这里造假入口**。
 */
export function PlusMenu({ onInsert }: { onInsert: (text: string) => void }) {
  const t = useT()
  const pickImages = useStore((s) => s.pickImages)
  const pickFiles = useStore((s) => s.pickFiles)
  const openSettings = useStore((s) => s.openSettings)
  /* 派发归属固定为活动会话：peek 着别的会话时不能派 */
  const peeking = useStore((s) => !!s.peekedSessionId)
  const [delegateOpen, setDelegateOpen] = useState(false)

  return (
    <>
    <MenuTrigger>
      <IconButton aria-label={t('composer.attach')} className="composer-plus" data-testid="composer-plus">
        <span className="composer-plus-glyph" aria-hidden>＋</span>
      </IconButton>
      <Popover className="composer-plus-pop" placement="top start" offset={6}>
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
