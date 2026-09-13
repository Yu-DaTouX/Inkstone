param([int]$ReviewProcessId, [string]$OutputPath)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ReviewCapture {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
'@
[void][ReviewCapture]::SetProcessDPIAware()
$reviewProcess = Get-Process -Id $ReviewProcessId -ErrorAction Stop
$reviewHandle = $reviewProcess.MainWindowHandle
if ($reviewHandle -eq [IntPtr]::Zero) { throw 'Test window has no native handle' }
$reviewRect = New-Object ReviewCapture+Rect
[void][ReviewCapture]::GetWindowRect($reviewHandle, [ref]$reviewRect)
$reviewBitmap = New-Object System.Drawing.Bitmap(($reviewRect.Right - $reviewRect.Left), ($reviewRect.Bottom - $reviewRect.Top))
$reviewGraphics = [System.Drawing.Graphics]::FromImage($reviewBitmap)
$reviewDc = $reviewGraphics.GetHdc()
try {
  if (-not [ReviewCapture]::PrintWindow($reviewHandle, $reviewDc, 2)) { throw 'Native window capture failed' }
} finally { $reviewGraphics.ReleaseHdc($reviewDc) }
try { $reviewBitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png) }
finally { $reviewGraphics.Dispose(); $reviewBitmap.Dispose() }
