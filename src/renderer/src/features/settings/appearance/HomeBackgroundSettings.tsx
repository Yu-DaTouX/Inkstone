import { useState, type ReactElement } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Button, Slider } from '../../../ui'
import { asciiBackgroundEnabled, asciiBackgroundPatch } from '../../ambient/ascii-field-model'
import { HOME_BLUR_MAX, homeBackgroundMode, shrinkImage, updateHomeBackground, useHomeBackground, type HomeBackgroundMode } from '../../ambient/home-background'
import { Segmented, SettingsGroup, SettingsRow } from '../root/controls'
import './home-background-settings.css'

interface HomeBackgroundText {
  group: string
  mode: string
  modeDesc: string
  ascii: string
  image: string
  none: string
  picture: string
  pictureDesc: string
  choose: string
  replace: string
  remove: string
  fade: string
  fadeDesc: string
  blur: string
  blurDesc: string
  tone: string
  toneDesc: string
  tonePage: string
  toneDark: string
  toneLight: string
  failed: string
}

const TEXT: Record<'zh-CN' | 'en-US', HomeBackgroundText> = {
  'zh-CN': {
    group: '背景',
    mode: '背景',
    modeDesc: '动态字符只在新会话空白页出现；图片在会话里也显示，并自动再淡一些。图片只存在这台电脑上。',
    ascii: '动态字符',
    image: '图片',
    none: '无',
    picture: '背景图片',
    pictureDesc: '支持 PNG、JPG、WebP、GIF、BMP，过大的图片会自动缩小。',
    choose: '选择图片…',
    replace: '更换图片…',
    remove: '移除',
    fade: '遮罩强度',
    fadeDesc: '遮罩盖在图片上的浓度，越大文字越清楚。会话里会在此基础上再加深一半。',
    blur: '虚化',
    blurDesc: '把图片模糊开，0 为原图。',
    tone: '遮罩颜色',
    toneDesc: '跟随底色时浅色主题偏白、深色主题偏黑。',
    tonePage: '跟随底色',
    toneDark: '黑',
    toneLight: '白',
    failed: '图片读取失败'
  },
  'en-US': {
    group: 'Background',
    mode: 'Background',
    modeDesc: 'Drifting characters show only on the empty new-session page; an image also shows inside sessions, a little fainter. Images stay on this computer.',
    ascii: 'Drifting characters',
    image: 'Image',
    none: 'None',
    picture: 'Background image',
    pictureDesc: 'PNG, JPG, WebP, GIF or BMP. Large images are scaled down.',
    choose: 'Choose image…',
    replace: 'Replace image…',
    remove: 'Remove',
    fade: 'Mask strength',
    fadeDesc: 'How strongly the mask covers the image; higher keeps text easier to read. Sessions deepen it halfway further.',
    blur: 'Blur',
    blurDesc: 'Softens the image; 0 keeps it sharp.',
    tone: 'Mask color',
    toneDesc: 'Page color is light in the light theme and dark in the dark theme.',
    tonePage: 'Page color',
    toneDark: 'Black',
    toneLight: 'White',
    failed: 'Could not read the image'
  }
}

export function HomeBackgroundSettings(): ReactElement {
  const { lang } = useI18n()
  const text = TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const background = useHomeBackground()
  const asciiOn = asciiBackgroundEnabled(settings)
  const [picked, setPicked] = useState<HomeBackgroundMode | null>(null)
  const mode = picked ?? homeBackgroundMode(background, asciiOn)
  const [busy, setBusy] = useState(false)

  const choose = (next: HomeBackgroundMode): void => {
    setPicked(next === 'image' && !background.image ? 'image' : null)
    if (next !== 'image' || background.image) updateHomeBackground({ mode: next })
    if ((next === 'ascii') !== asciiOn) void patchSettings(asciiBackgroundPatch(next === 'ascii')).catch(() => undefined)
  }

  const pickImage = async (): Promise<void> => {
    setBusy(true)
    try {
      const [file] = await window.yan.pickImages()
      if (!file) return
      const image = await shrinkImage(`data:${file.mimeType};base64,${file.data}`)
      updateHomeBackground({ mode: 'image', image })
      setPicked(null)
      if (asciiOn) void patchSettings(asciiBackgroundPatch(false)).catch(() => undefined)
    } catch (error) {
      useStore.getState().notify('error', `${text.failed}：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const removeImage = (): void => {
    updateHomeBackground({ image: null, mode: 'none' })
    setPicked(null)
  }

  return (
    <SettingsGroup title={text.group}>
      <SettingsRow settingId="appearance-ascii-background" label={text.mode} description={text.modeDesc}>
        <Segmented
          label={text.mode}
          value={mode}
          options={[
            { value: 'ascii', label: text.ascii, testId: 'v3-home-bg-ascii' },
            { value: 'image', label: text.image, testId: 'v3-home-bg-image' },
            { value: 'none', label: text.none, testId: 'v3-home-bg-none' }
          ]}
          onChange={choose}
        />
      </SettingsRow>
      {mode === 'image' ? (
        <SettingsRow settingId="appearance-home-image" label={text.picture} description={text.pictureDesc}>
          <div className="home-bg-picker">
            {background.image ? <img className="home-bg-thumb" src={background.image} alt="" data-testid="v3-home-bg-thumb" /> : null}
            <Button size="sm" variant="secondary" icon={<ImagePlus size={14} aria-hidden />} isPending={busy} onPress={() => void pickImage()} data-testid="v3-home-bg-choose">
              {background.image ? text.replace : text.choose}
            </Button>
            {background.image ? (
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} aria-hidden />} onPress={removeImage} data-testid="v3-home-bg-remove">
                {text.remove}
              </Button>
            ) : null}
          </div>
        </SettingsRow>
      ) : null}
      {mode === 'image' && background.image ? (
        <>
          <SettingsRow settingId="appearance-home-image-blur" label={text.blur} description={text.blurDesc}>
            <div className="home-bg-slider">
              <output className="home-bg-value ui-num" aria-hidden>{`${background.blur}px`}</output>
              <Slider
                className="home-bg-range"
                aria-label={text.blur}
                minValue={0}
                maxValue={HOME_BLUR_MAX}
                step={2}
                value={background.blur}
                onChange={(value) => updateHomeBackground({ blur: Array.isArray(value) ? value[0] : value })}
                data-testid="v3-home-bg-blur"
              />
            </div>
          </SettingsRow>
          <SettingsRow settingId="appearance-home-image-tone" label={text.tone} description={text.toneDesc}>
            <Segmented
              label={text.tone}
              value={background.tone}
              options={[
                { value: 'page', label: text.tonePage, testId: 'v3-home-bg-tone-page' },
                { value: 'dark', label: text.toneDark, testId: 'v3-home-bg-tone-dark' },
                { value: 'light', label: text.toneLight, testId: 'v3-home-bg-tone-light' }
              ]}
              onChange={(tone) => updateHomeBackground({ tone })}
            />
          </SettingsRow>
          <SettingsRow settingId="appearance-home-image-fade" label={text.fade} description={text.fadeDesc}>
            <div className="home-bg-slider">
              <output className="home-bg-value ui-num" aria-hidden>{`${Math.round(background.fade * 100)}%`}</output>
              <Slider
                className="home-bg-range"
                aria-label={text.fade}
                minValue={0}
                maxValue={0.9}
                step={0.05}
                value={background.fade}
                onChange={(value) => updateHomeBackground({ fade: Array.isArray(value) ? value[0] : value })}
                data-testid="v3-home-bg-fade"
              />
            </div>
          </SettingsRow>
        </>
      ) : null}
    </SettingsGroup>
  )
}
