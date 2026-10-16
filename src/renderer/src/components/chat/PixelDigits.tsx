const GLYPHS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  ':': ['000', '010', '000', '010', '000'],
  ' ': ['000', '000', '000', '000', '000']
}

function glyphOf(ch: string): readonly string[] {
  return GLYPHS[ch] ?? GLYPHS[' ']
}

export function PixelDigits({ text, className = '' }: { text: string; className?: string }) {
  return (
    <span className={`px-digits ${className}`.trim()} aria-hidden="true">
      {[...text].map((ch, i) => (
        <span className="px-char" key={`${ch}-${i}`}>
          {glyphOf(ch).flatMap((row, y) =>
            [...row].map((bit, x) => (
              <i key={`${x}-${y}`} className={bit === '1' ? 'px-dot on' : 'px-dot'} />
            ))
          )}
        </span>
      ))}
    </span>
  )
}
