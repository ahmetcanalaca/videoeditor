# Drives the REAL installer window (not silent) page by page and saves a screenshot of every page, to check the Turkish / English texts, and does
# the same for the uninstaller (confirm page and the "delete my data?" question).
#   powershell -NoProfile -File tests\installer-shots.ps1 -Setup <setup.exe> -Lang tr|en -Dir <install folder> -Out <folder for the png files> [-DataDir <folder>]
# -DataDir: the data folder of the FAST test build (build\test-appdata); a file is put there so that the uninstaller asks whether to delete it.
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][ValidateSet('tr', 'en')][string]$Lang,
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$DataDir = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string cls, string title);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  public static string Text(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  // a control with this id anywhere below the window (the pages of the installer are nested dialogs)
  public static IntPtr FindDescendantById(IntPtr root, int id) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(root, delegate (IntPtr h, IntPtr l) {
      if (GetDlgCtrlID(h) == id) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // a visible top-level window whose title contains the text (and, when controlId is not 0, that has a control with this id)
  public static IntPtr FindByTitle(string part, int controlId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && Text(h).IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0 && (controlId == 0 || GetDlgItem(h, controlId) != IntPtr.Zero)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindByTitle(string part) { return FindByTitle(part, 0); }
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  // the window's own picture, whatever lies on top of it (PW_RENDERFULLCONTENT)
  public static bool Print(IntPtr h, IntPtr hdc) { return PrintWindow(h, hdc, 2); }
  // the first check box below the window (class Button, style BS_CHECKBOX / BS_AUTOCHECKBOX): the "start the app now" box of the finish page
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int index);
  public static IntPtr FindCheckbox(IntPtr root) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(root, delegate (IntPtr h, IntPtr l) {
      var sb = new StringBuilder(64);
      GetClassName(h, sb, 64);
      if (sb.ToString() == "Button") { int t = GetWindowLong(h, -16) & 0xF; if (t == 2 || t == 3) { found = h; return false; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[void][Win]::SetProcessDPIAware()
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Wait-Window([string]$part, [int]$seconds) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $seconds) {
    $h = [Win]::FindByTitle($part)
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 300
  }
  throw "window '$part' did not appear"
}
function Shot([IntPtr]$h, [string]$name) {
  Start-Sleep -Milliseconds 900
  $r = New-Object 'Win+RECT'
  [void][Win]::GetWindowRect($h, [ref]$r)
  $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][Win]::Print($h, $hdc)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $file = Join-Path $Out "installer-$Lang-$name.png"
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("  {0}  (window title: '{1}')" -f $file, [Win]::Text($h))
}
function Press([IntPtr]$h, [int]$id) {
  $b = [Win]::GetDlgItem($h, $id)
  if ($b -eq [IntPtr]::Zero) { throw "no button $id in the window '$([Win]::Text($h))'" }
  [void][Win]::SendMessage($b, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) # BM_CLICK
}

# ---------------------------------------------------------------- install
# window titles (NSIS): "Video Editör Kurulumu" / "Video Editor Setup"; uninstaller "... Kaldır..." / "... Uninstall"; nothing else may match (a running editor window has "Video Editor" in its title too)
$setupTitle = if ($Lang -eq 'tr') { 'Kurulum' } else { 'Setup' }
$uninstTitle = if ($Lang -eq 'tr') { 'Kald' } else { 'Uninstall' }
$p = Start-Process -FilePath $Setup -ArgumentList "/LANG=$Lang /D=$Dir" -PassThru
$h = Wait-Window $setupTitle 30
Shot $h 'welcome'
Press $h 1
Start-Sleep -Seconds 1
Shot $h 'components'
Press $h 1
Start-Sleep -Seconds 1
Shot $h 'directory'
Press $h 1
# the files are copied (this takes a while); the finish page follows by itself: wait for its check box
$run = [IntPtr]::Zero
$t0 = Get-Date
while ($run -eq [IntPtr]::Zero -and ((Get-Date) - $t0).TotalSeconds -lt 240) {
  Start-Sleep -Seconds 1
  $run = [Win]::FindCheckbox($h)
}
Start-Sleep -Seconds 2
# untick "start the app now" (the MUI2 finish page is made with nsDialogs: the only check box on it) - it is ticked by default and the test must not leave a running app behind
if ($run -eq [IntPtr]::Zero) { throw 'the "start the app now" checkbox was not found on the finish page' }
if ([int][Win]::SendMessage($run, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero) -eq 1) { [void][Win]::SendMessage($run, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) } # BM_GETCHECK, BM_CLICK
Start-Sleep -Milliseconds 300
if ([int][Win]::SendMessage($run, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero) -ne 0) { throw 'the checkbox could not be unticked' }
Shot $h 'finish'
Press $h 1
[void]$p.WaitForExit(30000)

# ---------------------------------------------------------------- uninstall
if ($DataDir) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null; Set-Content -Path (Join-Path $DataDir 'settings.json') -Value '{}' }
$u = Start-Process -FilePath (Join-Path $Dir 'uninstall.exe') -PassThru
$uh = Wait-Window $uninstTitle 30
Shot $uh 'uninstall-confirm'
Press $uh 1
if ($DataDir) {
  # the question about the application's own data (it is a message box with a "No" button, id 7)
  $t0 = Get-Date
  $mb = [IntPtr]::Zero
  while ($mb -eq [IntPtr]::Zero -and ((Get-Date) - $t0).TotalSeconds -lt 60) {
    $mb = [Win]::FindByTitle('Video Edit', 7)
    if ($mb -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 300 }
  }
  if ($mb -ne [IntPtr]::Zero) { Shot $mb 'uninstall-data-question'; Press $mb 7 } else { Write-Output '  (the data question did not appear)' }
}
$t0 = Get-Date
while ((Test-Path (Join-Path $Dir 'VideoEditor.exe')) -and ((Get-Date) - $t0).TotalSeconds -lt 120) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 3
$fh = [Win]::FindByTitle($uninstTitle, 1)
if ($fh -ne [IntPtr]::Zero) { Shot $fh 'uninstall-done'; Press $fh 1 }
if ($DataDir) { Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue }
Write-Output ("installed folder left: {0}" -f (Test-Path (Join-Path $Dir 'VideoEditor.exe')))
