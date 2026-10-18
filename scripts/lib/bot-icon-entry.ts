import { BOT_FORMS, MONO_INK, drawBot, luminance, poseAt, type BotLook, type BotMood } from '../../src/renderer/src/patterns/model-bot/draw'

type Theme = 'light' | 'dark'

async function load(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  await image.decode()
  return image
}

function tint(image: HTMLImageElement, ink: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = ink
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

async function lookOf(brand: keyof typeof BOT_FORMS, theme: Theme): Promise<BotLook> {
  const form = BOT_FORMS[brand]
  const paint = form.mono ? MONO_INK[theme] : form.paint ?? MONO_INK[theme]
  const art = await load(form.art)
  const field = form.field ? await load(form.field) : null
  return { form, paint, dark: luminance(paint) < 0.35, art: form.mono ? tint(art, paint) : art, field }
}

export async function renderBotIcon(brand: keyof typeof BOT_FORMS, mood: BotMood, theme: Theme, size: number): Promise<string> {
  const look = await lookOf(brand, theme)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const pose = poseAt(mood, look.form, { t: 0, seed: 0, since: 0, entrance: false, restTurn: 0, still: true, size })
  drawBot(canvas.getContext('2d')!, look, size, pose)
  return canvas.toDataURL('image/png')
}

export function monoBrands(): string[] {
  return Object.entries(BOT_FORMS).filter(([, form]) => form.mono).map(([brand]) => brand)
}

export function allBrands(): string[] {
  return Object.keys(BOT_FORMS)
}
