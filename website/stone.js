const VERT = 'attribute vec2 a; void main() { gl_Position = vec4(a, 0., 1.); }'

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uCell;
uniform vec3 uStone;
uniform vec2 uPrompt;
uniform vec3 uMouse;
uniform vec2 uFade;
uniform float uDecode;
uniform float uGlint;
uniform float uScatter;
uniform float uLight;
uniform vec3 uBg;
uniform vec3 uAccent;

const vec2 LD = vec2(-.55, -.835);
const vec2 POOL_C = vec2(-.2, 0.);
const vec2 POOL_B = vec2(.72, .305);
const vec2 WELL_C = vec2(.765, .1);
const vec2 WELL_B = vec2(.165, .2);
const vec2 KEY_C = vec2(.675, -.262);
const vec2 KEY_B = vec2(.085, .078);

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = .5, s = 0.;
  for (int i = 0; i < 4; i++) {
    s += a * noise(p);
    p = p * 2.03 + 17.3;
    a *= .5;
  }
  return s;
}
float fbm2(vec2 p) {
  return (.5 * noise(p) + .25 * noise(p * 2.03 + 17.3)) * 1.25;
}
float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r;
}
vec2 boxNormal(vec2 p, vec2 b, float r) {
  const vec2 e = vec2(.004, 0.);
  return normalize(vec2(box(p + e.xy, b, r) - box(p - e.xy, b, r), box(p + e.yx, b, r) - box(p - e.yx, b, r)) + 1e-6);
}
float flow(vec2 w, float t) {
  vec2 q = vec2(fbm2(w + vec2(0., t)), fbm2(w + vec2(5.2, 1.3 - t)));
  vec2 r = vec2(fbm2(w + 3. * q + vec2(1.7, 9.2) + .5 * t), fbm2(w + 3. * q + vec2(8.3, 2.8) - .4 * t));
  return fbm2(w + 3.2 * r);
}
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2. + a.y * a.y * .75);
}
float bayer4(vec2 a) {
  return bayer2(.5 * a) * .25 + bayer2(a);
}
float bit(float row, float x) {
  float m = x < .5 ? 16. : x < 1.5 ? 8. : x < 2.5 ? 4. : x < 3.5 ? 2. : 1.;
  return mod(floor(row / m), 2.);
}
float prompt(vec2 px) {
  vec2 g = floor(px / uCell) - uPrompt;
  float on = 0.;
  if (g.x >= 0. && g.x < 5. && g.y >= 0. && g.y < 7.) {
    float y = g.y;
    float row = y < .5 ? 16. : y < 1.5 ? 8. : y < 2.5 ? 4. : y < 3.5 ? 2. : y < 4.5 ? 4. : y < 5.5 ? 8. : 16.;
    on = bit(row, g.x);
  }
  vec2 h = g - vec2(7., 0.);
  if (h.x >= 0. && h.x < 5. && h.y > 5.5 && h.y < 7.) on = max(on, step(.5, fract(uTime * .8)));
  return on;
}

float scene(vec2 px, out float d0) {
  vec2 s = (px - uStone.xy) / uStone.z;
  d0 = box(s, vec2(1., .4), .075);
  if (d0 > 0.) return 0.;
  float v = .25 + .17 * (fbm(s * 5.5 + 3.1) - .47) - .065 * (s.x * .5 + s.y * 2.2);
  float l0 = dot(boxNormal(s, vec2(1., .4), .075), LD);
  v += smoothstep(-.05, -.006, d0) * (l0 > 0. ? l0 * .8 : l0 * .2);

  float d3 = box(s - KEY_C, KEY_B, .026);
  if (d3 < 0.) {
    float l3 = dot(boxNormal(s - KEY_C, KEY_B, .026), LD);
    v = .34 + smoothstep(-.03, -.004, d3) * (l3 > 0. ? l3 * .7 : l3 * .26);
  } else {
    v *= .3 + .7 * smoothstep(0., .03, d3);
  }
  float d4 = box(s - vec2(.885, -.262), vec2(.072, .009), .009);
  v = mix(.012, v, smoothstep(-.002, .008, d4));

  float d1 = box(s - POOL_C, POOL_B, .1);
  if (d1 < 0.) {
    vec2 u = (s - POOL_C) / POOL_B;
    float f = flow(u * vec2(1.6, .78) + 1.7, uTime * .034);
    float lane = smoothstep(-1.15, .55, u.x * .7 - u.y * .9);
    float ink = .012 + .9 * smoothstep(.44, .7, f) * (.12 + .88 * lane);
    ink *= 1. - .85 * smoothstep(-.1, 0., box(s - POOL_C + LD * .075, POOL_B, .1));
    ink = mix(.012, ink, smoothstep(.75, 1.6, length((px / uCell - uPrompt - vec2(6., 3.5)) / vec2(9.5, 6.))));
    float l1 = dot(-boxNormal(s - POOL_C, POOL_B, .1), LD);
    v = mix(ink, .03 + max(l1, 0.) * .95, smoothstep(-.04, -.006, d1));
    v = max(v, prompt(px));
  }
  float d2 = box(s - WELL_C, WELL_B, .07);
  if (d2 < 0.) {
    vec2 u = (s - WELL_C) / WELL_B;
    float f = flow(u * vec2(.8, 1.) + 8.4, uTime * .045);
    float ink = .012 + .62 * smoothstep(.47, .76, f) * smoothstep(-.9, .6, u.y);
    ink *= 1. - .85 * smoothstep(-.11, 0., box(s - WELL_C + LD * .085, WELL_B, .07));
    float l2 = dot(-boxNormal(s - WELL_C, WELL_B, .07), LD);
    v = mix(ink, .03 + max(l2, 0.) * .9, smoothstep(-.038, -.006, d2));
  }
  return clamp(v, 0., 1.);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec3 fg = uLight > .5 ? vec3(.043) : vec3(1.);

  float pitch = uCell * 2.;
  vec2 bc = floor(px / pitch);
  vec2 bcen = (bc + .5) * pitch;
  float drift = fbm(bc * .085 + vec2(uTime * .05, -uTime * .032));
  float wave = .5 + .5 * sin(bc.x * .21 + bc.y * .33 - uTime * .85);
  vec2 dm = bcen - uMouse.xy;
  float reach = uCell * 26.;
  float near = uMouse.z * exp(-dot(dm, dm) / (reach * reach));
  float spark = step(.9965, hash(bc + floor(uTime * 5.) * 1.37));
  float f = clamp(smoothstep(.42, .78, drift) * (.3 + .7 * wave) * .6 + near * .95 + spark * .75, 0., 1.);
  float fade = smoothstep(uFade.x, uFade.x + pitch * 3., px.y) * (1. - smoothstep(uFade.y - pitch * 5., uFade.y, px.y));
  float br = pitch * (.05 + .12 * f);
  float ba = (1. - smoothstep(br - .7, br + .7, length(px - bcen))) * (.1 + .6 * f) * fade * (1. - .6 * uScatter);
  vec4 col = vec4(mix(fg, uAccent, near * .75) * ba, ba);

  float z = 1. + uScatter * 1.7;
  vec2 q = uStone.xy + (px - uStone.xy) / z;
  vec2 sb = abs(q - uStone.xy) / uStone.z;
  if (sb.x < 1.04 && sb.y < .44) {
    vec2 cell = floor(q / uCell);
    vec2 center = (cell + .5) * uCell;
    float dC;
    float vC = scene(center, dC);
    if (dC <= 0.) {
      float lum = clamp(pow(vC, .8) * 1.15, 0., 1.);
      if (uLight > .5) lum = 1. - lum;
      float cols = 2. * uStone.z / uCell;
      float colI = (center.x - (uStone.x - uStone.z)) / uCell;
      float rowI = (center.y - (uStone.y - .4 * uStone.z)) / uCell;
      float rnd = hash(cell + floor(uTime * 18.) * .37);
      float hot = 0.;
      float edge = uDecode * (cols + 18.) - 9.;
      float me = colI + mod(cell.y * 7. + cell.x * 13., 9.) - 4.;
      if (me > edge) {
        lum = step(.62, rnd) * .5;
      } else if (me > edge - 3.) {
        lum = step(.35, rnd);
        hot = 1.;
      } else if (abs(colI * .6 + rowI - uGlint) < 2.5 && rnd < .6) {
        lum = max(lum, .8);
        hot = 1.;
      }
      float level = min(1., floor(lum * 6. + .2 + .6 * bayer4(cell)) / 6.);
      float gone = step(hash(cell * 1.31 + 4.7), uScatter * 1.25);
      vec2 jit = (vec2(hash(cell + 3.1), hash(cell + 7.7)) - .5) * uCell * .45 * uScatter;
      float rad = uCell * mix(.15, .47, level) * (1. - .45 * uScatter);
      float a = 1. - smoothstep(rad - .75, rad + .75, length(q - center - jit) * z);
      a *= (1. - gone) * (1. - smoothstep(.5, 1., uScatter));
      vec3 lit = hot > .5 && level > 0. ? uAccent : mix(uBg, fg, mix(.13, 1., level));
      float back = (1. - a) * (1. - smoothstep(0., .3, uScatter));
      vec4 dots = vec4(lit * a + uBg * back, a + back);
      col = dots + col * (1. - dots.a);
    }
  }
  gl_FragColor = col;
}
`

export function mountStone({ canvas, hero, word, pitch }) {
  const still = new URLSearchParams(location.search).has('still') || matchMedia('(prefers-reduced-motion: reduce)').matches
  const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: true })
  if (!gl) return null

  const compile = (type, source) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
    return shader
  }
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const attr = gl.getAttribLocation(program, 'a')
  gl.enableVertexAttribArray(attr)
  gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0)
  gl.clearColor(0, 0, 0, 0)

  const loc = (name) => gl.getUniformLocation(program, name)
  const u = {
    res: loc('uRes'), time: loc('uTime'), cell: loc('uCell'), stone: loc('uStone'), prompt: loc('uPrompt'), mouse: loc('uMouse'),
    fade: loc('uFade'), decode: loc('uDecode'), glint: loc('uGlint'), scatter: loc('uScatter'), light: loc('uLight'), bg: loc('uBg'), accent: loc('uAccent')
  }
  const nav = hero.querySelector('.nav')
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, amt: 0, moved: -1e9 }
  const startAt = performance.now()
  let geo = null
  let visible = true
  let raf = 0
  let light = false
  let scatter = 0

  function layout() {
    const box = hero.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 1.5)
    const W = Math.max(1, box.width), H = Math.max(1, box.height)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)
    const narrow = W < 760
    const cell = Math.max(4, Math.round(Math.max(4.4, Math.min(7, W / 230)) * dpr))
    const wordBox = word.getBoundingClientRect()
    const pitchTop = pitch.getBoundingClientRect().top - box.top
    const top = wordBox.bottom - box.top - wordBox.height * (narrow ? 0.14 : 0.3)
    const room = pitchTop - top - 30
    const halfCss = Math.max(90, Math.min(W * (narrow ? 0.46 : 0.31), 470, room / 0.8))
    const half = Math.round(halfCss * dpr / cell) * cell
    const cx = Math.round(canvas.width / 2 / cell) * cell
    const cy = Math.round((top * dpr + half * 0.4) / cell) * cell
    const inset = Math.max(3, Math.round(0.075 * half / cell))
    if (!geo) {
      mouse.x = mouse.tx = cx
      mouse.y = mouse.ty = cy
    }
    geo = { dpr, cell, half, cx, cy }
    gl.uniform2f(u.res, canvas.width, canvas.height)
    gl.uniform1f(u.cell, cell)
    gl.uniform3f(u.stone, cx, cy, half)
    gl.uniform2f(u.prompt, Math.round((cx - 0.92 * half) / cell) + inset, Math.round((cy - 0.305 * half) / cell) + inset)
    gl.uniform2f(u.fade, (nav.getBoundingClientRect().bottom - box.top) * dpr, pitchTop * dpr)
  }

  function draw(now) {
    const seconds = (now - startAt) / 1000
    if (!still) {
      mouse.x += (mouse.tx - mouse.x) * 0.14
      mouse.y += (mouse.ty - mouse.y) * 0.14
      mouse.amt += ((now - mouse.moved < 2600 ? 1 : 0) - mouse.amt) * 0.06
    }
    const cols = 2 * geo.half / geo.cell, rows = 0.8 * geo.half / geo.cell
    const cycle = (seconds - 1.9) % 7
    gl.uniform3f(u.mouse, mouse.x, mouse.y, still ? 0 : mouse.amt)
    gl.uniform1f(u.time, still ? 21.9 : seconds)
    gl.uniform1f(u.decode, still ? 2 : Math.min(1.2, seconds / 1.7 * 1.2))
    gl.uniform1f(u.glint, !still && seconds > 1.9 && cycle < 2.4 ? cycle / 2.4 * (cols * 0.6 + rows) * 1.2 - 5 : -1e4)
    gl.uniform1f(u.scatter, still ? 0 : scatter)
    gl.uniform1f(u.light, light ? 1 : 0)
    gl.uniform3f(u.bg, ...(light ? [0.988, 0.988, 0.984] : [0, 0, 0]))
    gl.uniform3f(u.accent, ...(light ? [0.157, 0.459, 0.824] : [0.427, 0.655, 0.925]))
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function loop(now) {
    raf = 0
    if (!visible || document.hidden) return
    draw(now)
    raf = requestAnimationFrame(loop)
  }
  function wake() {
    if (still) draw(performance.now())
    else if (!raf) raf = requestAnimationFrame(loop)
  }

  hero.addEventListener('pointermove', (event) => {
    const box = hero.getBoundingClientRect()
    mouse.tx = (event.clientX - box.left) * geo.dpr
    mouse.ty = (event.clientY - box.top) * geo.dpr
    mouse.moved = performance.now()
  })
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting
    if (visible) wake()
  }).observe(hero)
  document.addEventListener('visibilitychange', wake)
  const relayout = () => { layout(); wake() }
  const sized = new ResizeObserver(relayout)
  sized.observe(hero)
  sized.observe(pitch)

  layout()
  wake()
  if (document.fonts) document.fonts.ready.then(relayout)

  return {
    setLight(next) {
      light = next
      wake()
    },
    setScatter(next) {
      scatter = next
    }
  }
}
