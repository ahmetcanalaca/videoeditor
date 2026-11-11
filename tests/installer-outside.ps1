# Checks the folder page of the REAL installer window (not silent): a folder INSIDE the user's profile gets no question, a folder OUTSIDE it
# gets the warning (security review, second pass: on a shared PC another account could change the program files there). "Yes" keeps the user on the
# folder page and nothing is installed; "No" installs anyway. The program is installed for the test and removed again.
#   powershell -NoProfile -File tests\installer-outside.ps1 -Setup <setup.exe> -Lang tr|en -Inside <folder in the profile> -Outside <folder outside it> [-Out <folder for png files>]
# Use the FAST test installer (build\VideoEditor-fast-Setup-x64.exe): it keeps the application's data folder in a sandbox.
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][ValidateSet('tr', 'en')][string]$Lang,
  [Parameter(Mandatory = $true)][string]$Inside,
  [Parameter(Mandatory = $true)][string]$Outside,
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  // what the process shows right now (to explain a failed check): its visible dialogs, with the state of the "Next" button
  public static string Describe(uint pid) {
    var sb = new StringBuilder();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var cls = new StringBuilder(64); GetClassName(h, cls, 64);
        if (cls.ToString() == "#32770") sb.Append("[" + Text(h) + " | next enabled: " + (GetDlgItem(h, 1) != IntPtr.Zero ? IsWindowEnabled(GetDlgItem(h, 1)).ToString() : "-") + " | has Yes/No: " + (GetDlgItem(h, 7) != IntPtr.Zero) + "] ");
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
  public static string Text(IntPtr h) { var sb = new StringBuilder(2048); GetWindowText(h, sb, 2048); return sb.ToString(); }
  public static bool Print(IntPtr h, IntPtr hdc) { return PrintWindow(h, hdc, 2); }
  public static IntPtr FindDescendantById(IntPtr root, int id) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(root, delegate (IntPtr h, IntPtr l) { if (GetDlgCtrlID(h) == id) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  // a visible top-level window of THIS process whose title contains the text and that has a control with this id (0: any)
  public static IntPtr FindByTitle(string part, int controlId, uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Text(h).IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0 && (controlId == 0 || GetDlgItem(h, controlId) != IntPtr.Zero)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // all the text of the static controls of a window (the message of a message box)
  public static string AllText(IntPtr root) {
    var sb = new StringBuilder();
    EnumChildWindows(root, delegate (IntPtr h, IntPtr l) { var t = Text(h); if (t.Length > 20) sb.Append(t).Append(' '); return true; }, IntPtr.Zero);
    return sb.ToString();
  }
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
[void][W]::SetProcessDPIAware()
if ($Out) { New-Item -ItemType Directory -Force -Path $Out | Out-Null }

$failures = New-Object System.Collections.ArrayList
function Check([bool]$ok, [string]$what) {
  if ($ok) { Write-Output "PASS  $what" } else { Write-Output "FAIL  $what"; [void]$failures.Add($what) }
}
function Shot([IntPtr]$h, [string]$name) {
  if (-not $Out) { return }
  Start-Sleep -Milliseconds 700
  $r = New-Object 'W+RECT'
  [void][W]::GetWindowRect($h, [ref]$r)
  $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc(); [void][W]::Print($h, $hdc); $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save((Join-Path $Out "installer-outside-$Lang-$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
function Wait-Title([string]$part, [int]$controlId, [int]$seconds, [int]$processId) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $seconds) {
    $h = [W]::FindByTitle($part, $controlId, [uint32]$processId)
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 250
  }
  return [IntPtr]::Zero
}
function Press([IntPtr]$h, [int]$id) {
  $b = [W]::GetDlgItem($h, $id)
  if ($b -eq [IntPtr]::Zero) { throw "no button $id in '$([W]::Text($h))'" }
  # posted, not sent: a click that opens a message box does not return until the box is closed, and the test has to look at that box
  [void][W]::PostMessage($b, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) # BM_CLICK
}
function Registered { return [bool](Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoEditor' -ErrorAction SilentlyContinue) }

if (Registered) { throw 'a Video Editor installation is registered for this user: this test must not touch a real installation' }
$setupName = [IO.Path]::GetFileNameWithoutExtension($Setup)
if (@(Get-Process -Name $setupName -ErrorAction SilentlyContinue).Count) { throw "another process of $setupName is running: close it first (this test drives the windows of its own setup only)" }
$script:started = @()
$setupTitle = if ($Lang -eq 'tr') { 'Kurulum' } else { 'Setup' }
$msgTitle = 'Video Edit'

function Wait-Control([IntPtr]$h, [int]$id, [int]$seconds) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $seconds) {
    if ([W]::FindDescendantById($h, $id) -ne [IntPtr]::Zero) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# the folder page: welcome -> components -> folder, then "Next" on the folder page runs the check
function Go-To-FolderPage([string]$dir) {
  $p = Start-Process -FilePath $Setup -ArgumentList "/LANG=$Lang /D=$dir" -PassThru
  $script:started += $p
  try {
    $h = Wait-Title $setupTitle 1 30 $p.Id
    if ($h -eq [IntPtr]::Zero) { throw 'the setup window did not appear' }
    Press $h 1
    if (-not (Wait-Control $h 1032 20)) { throw 'the components page is not shown' } # 1032: its list of components
    Press $h 1
    if (-not (Wait-Control $h 1019 20)) { throw 'the folder page is not shown' } # 1019: the folder text box
  } catch {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    throw
  }
  return @{ Process = $p; Window = $h }
}
# "Next" on the folder page; the check of the folder runs and may show a message box. A posted click can be lost while the page is still busy, so it
# is repeated (and what the setup shows is reported) before the test concludes that there was no question.
function Press-Until-Box([IntPtr]$h, [int]$processId, [int]$attempts) {
  for ($i = 1; $i -le $attempts; $i++) {
    Press $h 1
    $mb = Wait-Title $msgTitle 7 6 $processId
    if ($mb -ne [IntPtr]::Zero) { if ($i -gt 1) { Write-Output "  (the click needed $i tries)" }; return $mb }
    Write-Output "  (no message box after click $i; the setup shows: $([W]::Describe([uint32]$processId)))"
  }
  return [IntPtr]::Zero
}
# finish the installation: wait for the finish page, untick "start now", press Finish
function Finish-Install([IntPtr]$h, $p) {
  $run = [IntPtr]::Zero
  $t0 = Get-Date
  while ($run -eq [IntPtr]::Zero -and ((Get-Date) - $t0).TotalSeconds -lt 240) { Start-Sleep -Seconds 1; $run = [W]::FindCheckbox($h) }
  if ($run -eq [IntPtr]::Zero) { throw 'the finish page did not appear' }
  Start-Sleep -Seconds 2
  if ([int][W]::SendMessage($run, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero) -eq 1) { [void][W]::SendMessage($run, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) }
  Press $h 1
  [void]$p.WaitForExit(30000)
}
function Uninstall([string]$dir) {
  $exe = Join-Path $dir 'uninstall.exe'
  if (Test-Path $exe) {
    $q = Start-Process -FilePath $exe -ArgumentList "/S _?=$dir" -PassThru -Wait
    Remove-Item -Force $exe -ErrorAction SilentlyContinue
  }
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}

try {
  # ---- 1. inside the profile: no question, the installation starts ----
  Remove-Item -Recurse -Force $Inside -ErrorAction SilentlyContinue
  $s = Go-To-FolderPage $Inside
  Press $s.Window 1
  $mb = Wait-Title $msgTitle 7 5 $s.Process.Id
  Check ($mb -eq [IntPtr]::Zero) "$Lang  a folder inside the user's profile: no warning"
  Finish-Install $s.Window $s.Process
  Check (Test-Path (Join-Path $Inside 'VideoEditor.exe')) "$Lang  ...and the program is installed there"
  Uninstall $Inside
  Check (-not (Registered)) "$Lang  ...and removed again (nothing registered)"

  # ---- 2. outside the profile: warning; Yes = stay on the folder page, nothing installed; No = install anyway ----
  Remove-Item -Recurse -Force $Outside -ErrorAction SilentlyContinue
  $s = Go-To-FolderPage $Outside
  $mb = Press-Until-Box $s.Window $s.Process.Id 3
  Check ($mb -ne [IntPtr]::Zero) "$Lang  a folder outside the user's profile: the warning appears"
  if ($mb -ne [IntPtr]::Zero) {
    $text = [W]::AllText($mb)
    # ASCII-only expectations: this file is read as ANSI by Windows PowerShell 5.1
    $expect = if ($Lang -eq 'tr') { @('Windows kullan', 'Evet:') } else { @('outside your Windows user profile', 'Yes:') }
    Check ($text.Contains($expect[0]) -and $text.Contains($expect[1])) "$Lang  ...with the text in the language of the setup"
    Shot $mb 'warning'
    Press $mb 6 # Yes: let me choose another folder
    Start-Sleep -Seconds 4
    Check (([W]::FindDescendantById($s.Window, 1019)) -ne [IntPtr]::Zero) "$Lang  ...Yes keeps the user on the folder page"
    Check (-not (Test-Path (Join-Path $Outside 'VideoEditor.exe'))) "$Lang  ...and nothing is installed"
    $mb = Press-Until-Box $s.Window $s.Process.Id 3
    Check ($mb -ne [IntPtr]::Zero) "$Lang  ...asked again on the next try"
    if ($mb -ne [IntPtr]::Zero) { Press $mb 7 } # No: install here anyway
    Finish-Install $s.Window $s.Process
    Check (Test-Path (Join-Path $Outside 'VideoEditor.exe')) "$Lang  ...No installs anyway"
  } else {
    Stop-Process -Id $s.Process.Id -Force
  }
} finally {
  # never leave a setup window of this test behind (a later run would find it)
  foreach ($q in $script:started) { if (-not $q.HasExited) { Stop-Process -Id $q.Id -Force -ErrorAction SilentlyContinue } }
  Uninstall $Inside
  Uninstall $Outside
  Remove-Item -Recurse -Force (Split-Path $Outside -Parent) -ErrorAction SilentlyContinue
}
Check (-not (Registered)) "$Lang  nothing left registered after the test"
if ($failures.Count) { Write-Output ("==== installer-outside ($Lang): {0} FAILED ====" -f $failures.Count); exit 1 }
Write-Output "==== installer-outside ($Lang): all passed ===="
