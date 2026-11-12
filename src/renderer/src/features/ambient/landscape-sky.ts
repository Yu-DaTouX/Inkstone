export interface MoonPhase {
  phase: number
  illumination: number
  waxing: boolean
}

export interface SkyBody {
  x: number
  height: number
  altitude: number
  fade: number
}

export interface MoonBody extends SkyBody, MoonPhase {
  tilt: number
}

export interface LandscapeSky {
  sun: SkyBody | null
  moon: MoonBody | null
}

export interface Observer {
  latitude: number
  longitude: number
}

interface Horizontal {
  altitude: number
  azimuth: number
  hourAngle: number
  declination: number
}

const DEG = Math.PI / 180
const OBLIQUITY = 23.4393 * DEG
const SUN_HORIZON = -0.833
const MOON_HORIZON = -0.3
const MOON_RISE_GEOCENTRIC = 0.125
const FADE_DEGREES = 3
const DAYLIGHT_MOON = 0.55

const ZONES: Readonly<Record<string, readonly [number, number]>> = {
  'Asia/Shanghai': [31.2, 121.5],
  'Asia/Chongqing': [29.6, 106.5],
  'Asia/Urumqi': [43.8, 87.6],
  'Asia/Hong_Kong': [22.3, 114.2],
  'Asia/Macau': [22.2, 113.5],
  'Asia/Taipei': [25.0, 121.5],
  'Asia/Tokyo': [35.7, 139.7],
  'Asia/Seoul': [37.6, 127.0],
  'Asia/Singapore': [1.3, 103.8],
  'Europe/London': [51.5, -0.1],
  'Europe/Berlin': [52.5, 13.4],
  'Europe/Paris': [48.9, 2.4],
  'America/New_York': [40.7, -74.0],
  'America/Chicago': [41.9, -87.6],
  'America/Los_Angeles': [34.1, -118.2],
  'Australia/Sydney': [-33.9, 151.2],
  'Australia/Melbourne': [-37.8, 145.0],
  'Pacific/Auckland': [-36.8, 174.8]
}

const SOUTHERN = /^(Australia|Antarctica)\/|^Pacific\/(Auckland|Chatham|Fiji)|^America\/(Argentina|Sao_Paulo|Santiago|Montevideo|Asuncion|La_Paz|Lima)|^Africa\/(Johannesburg|Maputo|Harare|Windhoek|Lusaka|Gaborone)/

const sin = (degrees: number): number => Math.sin(degrees * DEG)
const cos = (degrees: number): number => Math.cos(degrees * DEG)
const radians = (degrees: number): number => ((degrees % 360) * Math.PI) / 180
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const smooth = (value: number): number => {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

function validTime(at: number): boolean {
  return Number.isFinite(new Date(at).getTime())
}

export function observerFor(timeZone: string | undefined, at: number): Observer {
  const known = timeZone ? ZONES[timeZone] : undefined
  if (known) return { latitude: known[0], longitude: known[1] }
  const year = new Date(at).getFullYear()
  const standard = Math.max(new Date(year, 0, 1).getTimezoneOffset(), new Date(year, 6, 1).getTimezoneOffset())
  return { latitude: timeZone && SOUTHERN.test(timeZone) ? -33 : 35, longitude: -standard / 4 }
}

function localObserver(at: number): Observer {
  let zone: string | undefined
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    zone = undefined
  }
  return observerFor(zone, at)
}

export function moonPhase(at: number): MoonPhase | null {
  if (!validTime(at)) return null
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

function equatorial(longitude: number, latitude: number): { ra: number; dec: number } {
  const ra = Math.atan2(sin(longitude) * Math.cos(OBLIQUITY) - Math.tan(latitude * DEG) * Math.sin(OBLIQUITY), cos(longitude)) / DEG
  const dec = Math.asin(sin(latitude) * Math.cos(OBLIQUITY) + cos(latitude) * Math.sin(OBLIQUITY) * sin(longitude)) / DEG
  return { ra, dec }
}

function horizontal(ra: number, dec: number, days: number, observer: Observer): Horizontal {
  const sidereal = 280.46061837 + 360.98564736629 * days + observer.longitude
  const hour = sidereal - ra
  const phi = observer.latitude
  const altitude = Math.asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(hour)) / DEG
  const azimuth = (Math.atan2(sin(hour), cos(hour) * sin(phi) - Math.tan(dec * DEG) * cos(phi)) / DEG + 180 + 360) % 360
  return { altitude, azimuth, hourAngle: ((hour % 360) + 540) % 360 - 180, declination: dec }
}

export function sunPosition(at: number, observer: Observer): Horizontal {
  const days = at / 86_400_000 + 2440587.5 - 2451545
  const anomaly = 357.529 + 0.98560028 * days
  const longitude = 280.459 + 0.98564736 * days + 1.915 * sin(anomaly) + 0.02 * sin(2 * anomaly)
  const { ra, dec } = equatorial(longitude, 0)
  return horizontal(ra, dec, days, observer)
}

export function moonPosition(at: number, observer: Observer): Horizontal {
  const days = at / 86_400_000 + 2440587.5 - 2451545
  const t = days / 36525
  const mean = 218.3164477 + 481267.88123421 * t
  const elongation = 297.8501921 + 445267.1114034 * t
  const solar = 357.5291092 + 35999.0502909 * t
  const lunar = 134.9633964 + 477198.8675055 * t
  const node = 93.272095 + 483202.0175233 * t
  const longitude = mean + 6.289 * sin(lunar) + 1.274 * sin(2 * elongation - lunar) + 0.658 * sin(2 * elongation)
    + 0.214 * sin(2 * lunar) - 0.186 * sin(solar) - 0.114 * sin(2 * node)
  const latitude = 5.128 * sin(node) + 0.281 * sin(lunar + node) + 0.278 * sin(lunar - node)
  const { ra, dec } = equatorial(longitude, latitude)
  const geocentric = horizontal(ra, dec, days, observer)
  return { ...geocentric, altitude: geocentric.altitude - 0.9507 * cos(geocentric.altitude) }
}

function arcProgress(position: Horizontal, observer: Observer, rise: number): number {
  const phi = observer.latitude
  const dec = position.declination
  const limit = (sin(rise) - sin(phi) * sin(dec)) / (cos(phi) * cos(dec))
  const half = limit <= -1 ? 180 : limit >= 1 ? 0 : Math.acos(limit) / DEG
  return half > 0 ? 0.5 + position.hourAngle / (2 * half) : 0.5
}

function body(position: Horizontal, observer: Observer, horizon: number, rise: number): SkyBody | null {
  if (position.altitude <= horizon) return null
  return {
    x: clamp01(arcProgress(position, observer, rise)),
    height: clamp01(sin(position.altitude)),
    altitude: position.altitude,
    fade: smooth((position.altitude - horizon) / FADE_DEGREES)
  }
}

type Vector = [number, number, number]

const unit = (position: Horizontal): Vector => [cos(position.altitude) * sin(position.azimuth), cos(position.altitude) * cos(position.azimuth), sin(position.altitude)]
const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

function sunDirection(moon: Horizontal, sun: Horizontal, observer: Observer): number {
  const m = unit(moon)
  const s = unit(sun)
  const lift = m[2]
  const upRaw: Vector = [-m[0] * lift, -m[1] * lift, 1 - m[2] * lift]
  const length = Math.hypot(...upRaw) || 1
  const up: Vector = [upRaw[0] / length, upRaw[1] / length, upRaw[2] / length]
  const facingRight = cross(m, up)
  const right = observer.latitude >= 0 ? dot(s, facingRight) : -dot(s, facingRight)
  return Math.atan2(-dot(s, up), right)
}

export function landscapeSky(at: number, observer: Observer = localObserver(at)): LandscapeSky | null {
  if (!validTime(at)) return null
  const sunAt = sunPosition(at, observer)
  const moonAt = moonPosition(at, observer)
  const sun = body(sunAt, observer, SUN_HORIZON, SUN_HORIZON)
  const visibleMoon = body(moonAt, observer, MOON_HORIZON, MOON_RISE_GEOCENTRIC)
  const phase = moonPhase(at)
  const moon = visibleMoon && phase
    ? { ...visibleMoon, ...phase, fade: visibleMoon.fade * (sun ? DAYLIGHT_MOON : 1), tilt: sunDirection(moonAt, sunAt, observer) }
    : null
  return { sun, moon }
}

export function traceMoon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, moon: MoonPhase, tilt = moon.waxing ? 0 : Math.PI): void {
  const start = tilt - Math.PI / 2
  ctx.beginPath()
  ctx.moveTo(x + radius * Math.cos(start), y + radius * Math.sin(start))
  ctx.arc(x, y, radius, start, tilt + Math.PI / 2, false)
  const terminator = 1 - 2 * moon.illumination
  if (Math.abs(terminator) < 1e-6) ctx.lineTo(x + radius * Math.cos(start), y + radius * Math.sin(start))
  else ctx.ellipse(x, y, Math.abs(terminator) * radius, radius, tilt, Math.PI / 2, -Math.PI / 2, terminator > 0)
  ctx.closePath()
}
