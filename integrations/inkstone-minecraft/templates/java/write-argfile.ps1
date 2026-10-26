$ErrorActionPreference = 'Stop'
$file = $env:INKSTONE_JAVA_ARGFILE
if ([string]::IsNullOrEmpty($file)) { throw 'Missing INKSTONE_JAVA_ARGFILE' }
$text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
$encoding = [System.Text.Encoding]::GetEncoding([System.Text.Encoding]::Default.CodePage, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
$bytes = $encoding.GetBytes($text)
if ($encoding.GetString($bytes) -cne $text) { throw 'Java argument file cannot round-trip through the Windows native encoding' }
[System.IO.File]::WriteAllBytes($file, $bytes)
