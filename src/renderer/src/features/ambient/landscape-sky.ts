export interface MoonPhase {
  phase: number
  illumination: number
  waxing: boolean
}

export interface LandscapeSky {
  kind: 'sun' | 'moon'
  progress: number
  moon: MoonPhase | null
}

const radians = (degrees: number): number => ((degrees % 360) * Math.PI) / 180

export function moonPhase(at: number): MoonPhase | null {
  if (!Number.isFinite(new Date(at).getTime())) return null
  const t = (at / 86_400_000 + 2440587.5 - 2451545) / 36525
  const elongation = radians(297.8501921 + t * (445267.1114034 + t * (-0.0018819 + t * (1 / 545868 - t / 113065000))))
  const solarAnomaly = radians(357.5291092 + t * (35999.0502909 + t * (-0.0001536 + t / 24490000)))
  const lunarAnomaly = radians(134.9633964 + t * (477198.8675055 + t * (0.0087414 + t * (1 / 69699 - t / 14712000))))
  const angle = elongation + radians(
    6.289 * Math.sin(lunarAnomaly) - 2.1 * Math.sin(solarAnomaly)
    + 1.274 * Math.sin(2 * elongation - lunarAnomaly) + 0.658 * Math.sin(2 * elongation)
    + 0.214 * Math.sin(2 * lunarAnomaly) + 0.11 * Math.sin(elongation)
  )
  const phase = ((angle / (2 * Math.PI)) % 1 + 1) % 1
  return { phase, illumination: (1 - Math.cos(angle)) / 2, waxing: phase < 0.5 }
}

export function landscapeSky(at: number): LandscapeSky | null {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600
  const daytime = hour >= 6 && hour < 18
  return {
    kind: daytime ? 'sun' : 'moon',
    progress: (daytime ? hour - 6 : (hour + 6) % 24) / 12,
    moon: daytime ? null : moonPhase(at)
  }
}

export function traceMoon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, moon: MoonPhase): void {
  ctx.beginPath()
  ctx.moveTo(x, y - radius)
  ctx.arc(x, y, radius, -Math.PI / 2, Math.PI / 2, !moon.waxing)
  const terminator = 1 - 2 * moon.illumination
  if (Math.abs(terminator) < 1e-6) ctx.lineTo(x, y - radius)
  else ctx.ellipse(x, y, Math.abs(terminator) * radius, radius, 0, Math.PI / 2, -Math.PI / 2, moon.waxing === (terminator > 0))
  ctx.closePath()
}
