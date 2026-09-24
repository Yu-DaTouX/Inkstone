param(
  [ValidatePattern('^#[0-9A-Fa-f]{6}$')][string]$LightInk = '#242421',
  [ValidatePattern('^#[0-9A-Fa-f]{6}$')][string]$DarkInk = '#EFEEE9'
)

# GitHub wordmarks: preserve the canonical icon, outline the English name,
# and keep theme colors in these two parameters. Requires Windows fonts.
Add-Type -AssemblyName System.Drawing
$repoRoot = Split-Path -Parent $PSScriptRoot
$assetDir = Join-Path $repoRoot 'docs\assets\inkstone'
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
[xml]$icon = Get-Content -LiteralPath (Join-Path $repoRoot 'build\prompt-stone.svg') -Raw
$iconGroups = ($icon.DocumentElement.ChildNodes | Where-Object LocalName -eq 'g' | ForEach-Object OuterXml) -join ''
if (-not $iconGroups) { throw 'The canonical prompt-stone icon has no geometry.' }
$family = [System.Drawing.FontFamily]::new('Segoe UI Semibold')
$outline = [System.Drawing.Drawing2D.GraphicsPath]::new()
$outline.AddString('Inkstone', $family, 0, 100, [System.Drawing.PointF]::new(0,0), [System.Drawing.StringFormat]::GenericTypographic)
$bounds = $outline.GetBounds()
$factor = 82.0 / $bounds.Height
$glyphWidth = $bounds.Width * $factor
$left = (800 - 112 - 36 - $glyphWidth) / 2
$points = $outline.PathPoints
$types = $outline.PathTypes
$builder = [System.Text.StringBuilder]::new()
$culture = [System.Globalization.CultureInfo]::InvariantCulture
function N($number) { return $number.ToString('0.####', $culture) }
function P($point) { return (N (($point.X-$bounds.X)*$factor)) + ' ' + (N (($point.Y-$bounds.Y)*$factor)) }
$index = 0
while ($index -lt $points.Length) {
  $kind = $types[$index] -band 7
  if ($kind -eq 0) { [void]$builder.Append('M' + (P $points[$index])); $index++ }
  elseif ($kind -eq 1) {
    [void]$builder.Append('L' + (P $points[$index]))
    if (($types[$index] -band 128) -ne 0) { [void]$builder.Append('Z') }
    $index++
  } elseif ($kind -eq 3) {
    [void]$builder.Append('C' + (P $points[$index]) + ' ' + (P $points[$index+1]) + ' ' + (P $points[$index+2]))
    if (($types[$index+2] -band 128) -ne 0) { [void]$builder.Append('Z') }
    $index += 3
  } else { throw 'Unexpected font contour.' }
}
$iconScale = 112.0 / 62
$iconX = N ($left - 19*$iconScale)
$iconY = N (36 - 19*$iconScale)
$textX = N ($left + 148)
$scaleText = N $iconScale
$pathData = $builder.ToString()
foreach ($theme in @('light','dark')) {
  $ink = if ($theme -eq 'light') { $LightInk } else { $DarkInk }
  $svg = @"
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="184" viewBox="0 0 800 184" role="img" aria-labelledby="title desc" color="$ink">
  <title id="title">Inkstone · 砚</title>
  <desc id="desc">Inkstone desktop AI workspace. Canonical prompt-stone symbol and outlined wordmark. Transparent background.</desc>
  <g transform="translate($iconX $iconY) scale($scaleText)">$iconGroups</g>
  <path transform="translate($textX 51)" fill="currentColor" fill-rule="evenodd" d="$pathData"/>
</svg>
"@
  [System.IO.File]::WriteAllText((Join-Path $assetDir ('wordmark-' + $theme + '.svg')), $svg, [System.Text.UTF8Encoding]::new($false))
}
$outline.Dispose()
$family.Dispose()
Write-Output 'Generated docs/assets/inkstone/wordmark-{light,dark}.svg'
