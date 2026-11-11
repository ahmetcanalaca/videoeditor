<#
.SYNOPSIS
  Video Editor - Local AI: the helper of the web edition.

.DESCRIPTION
  Runs the AI model of Video Editor on THIS computer and pairs the web page with it.

  What it does (and nothing else):
    1. Downloads the AI engine (llama.cpp, from github.com) and the model (Qwen3.5-4B, from huggingface.co) on the first run.
       Every file is checked against a pinned SHA-256 (see pins.json) before it is used; a wrong file is deleted, never started.
    2. Starts the engine on 127.0.0.1 only (this computer, not the network) behind a random key (a new one at every start).
    3. Opens the web page with a pairing link (#local-ai=<port>.<key>). The part after "#" never goes to a server.
  No administrator rights. No account. Nothing is sent anywhere except the two downloads above.
  Close the window (or press ENTER) to stop the model and free the memory.

  The text shown in this window is in messages.json (English and Turkish).

.PARAMETER Port       first port to try (default 8473; the next free one is taken when it is busy)
.PARAMETER Backend    auto (graphics card when it has room, else processor), vulkan, cpu
.PARAMETER Site       the page to pair with (default: the published site, see pins.json)
.PARAMETER DataDir    where the engine, the model and the key are kept (default %LOCALAPPDATA%\VideoEditor-LocalAI)
.PARAMETER PinsFile   another pins file (tests)
.PARAMETER NoBrowser  do not open the page
.PARAMETER PrepareOnly  download and check everything, then stop
.PARAMETER Stop       stop a Local AI that runs in another window
.PARAMETER Remove     delete everything this helper downloaded (asks first)
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [ValidateSet('auto', 'vulkan', 'cpu')][string]$Backend = 'auto',
  [string]$Site = '',
  [string]$DataDir = '',
  [string]$PinsFile = '',
  [switch]$NoBrowser,
  [switch]$PrepareOnly,
  [switch]$Stop,
  [switch]$Remove
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------------------------------------------- text

$script:Lang = 'en'
try { if ([System.Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq 'tr') { $script:Lang = 'tr' } } catch { }
if ($env:VE_LOCALAI_LANG -eq 'en' -or $env:VE_LOCALAI_LANG -eq 'tr') { $script:Lang = $env:VE_LOCALAI_LANG }
$script:Messages = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'messages.json') -Raw -Encoding UTF8 | ConvertFrom-Json

function T([string]$Key, [object[]]$Values) {
  $prop = $script:Messages.($script:Lang).PSObject.Properties[$Key]
  if (-not $prop) { $prop = $script:Messages.en.PSObject.Properties[$Key] }
  if (-not $prop) { return $Key }
  if ($Values -and $Values.Count -gt 0) { return ([string]$prop.Value -f $Values) }
  return [string]$prop.Value
}

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

$script:OldEncoding = $null
try { $script:OldEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------------------------------------------------------------------------------------------------------------- setup

$script:Interactive = $true
try { if ([Console]::IsInputRedirected) { $script:Interactive = $false } } catch { $script:Interactive = $false }
$script:OutRedirected = $false
try { if ([Console]::IsOutputRedirected) { $script:OutRedirected = $true } } catch { }

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor ([Net.SecurityProtocolType]12288) } catch {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
}

function Fail([string]$Message, [int]$Code = 1) {
  $ex = New-Object System.Exception($Message)
  $ex.Data['code'] = $Code
  throw $ex
}

if ($env:OS -ne 'Windows_NT') { Fail (T 'err.os') 1 }

$pinsPath = if ($PinsFile) { $PinsFile } else { Join-Path $PSScriptRoot 'pins.json' }
$pins = Get-Content -LiteralPath $pinsPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'VideoEditor-LocalAI' }
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$modelDir = Join-Path $DataDir ('models\' + [string]$pins.model.dir)
$runtimeRoot = Join-Path $DataDir ('runtime\' + [string]$pins.llama.tag)
$downloadDir = Join-Path $DataDir 'downloads'
$keyFile = Join-Path $DataDir 'key.txt'
$stateFile = Join-Path $DataDir 'verified.json'
$pidFile = Join-Path $DataDir 'llama-server.pid.json'
$markerFile = Join-Path $DataDir '.video-editor-local-ai'
$stopFile = Join-Path $DataDir 'stop.flag'
$outLog = Join-Path $DataDir 'llama-server.out.log'
$errLog = Join-Path $DataDir 'llama-server.err.log'
# the model the desktop app of Video Editor may already have downloaded: used in place (after the same SHA-256 check), never changed
$desktopModelDir = if ($env:APPDATA) { Join-Path $env:APPDATA ('VideoEditor\models\' + [string]$pins.model.dir) } else { '' }
$exeName = 'llama-server.exe'

if (-not $Site) { $Site = [string]$pins.site }
$siteUri = $null
try { $siteUri = [System.Uri]$Site } catch { Fail ('Not a valid address: ' + $Site) 1 }
$siteLocal = ($siteUri.Host -eq '127.0.0.1' -or $siteUri.Host -eq 'localhost')
if (-not ($siteUri.Scheme -eq 'https' -or ($siteUri.Scheme -eq 'http' -and $siteLocal))) { Fail ('The page address must be https: ' + $Site) 1 }

$script:Verified = @{}
$script:Key = ''
$script:Proc = $null
$script:Started = $false
$script:ReusedFrom = ''
$script:LastPct = -10
$script:RetryDelay = 2
if ($env:VE_LOCALAI_RETRY_DELAY) { try { $script:RetryDelay = [double]$env:VE_LOCALAI_RETRY_DELAY } catch { } }

# ---------------------------------------------------------------------------------------------------------------- helpers

function Format-Size([double]$Bytes) {
  if ($Bytes -ge 1073741824) { return ('{0:N1} GB' -f ($Bytes / 1073741824)) }
  return ('{0:N0} MB' -f ($Bytes / 1048576))
}

function Get-FreeGb([string]$Path) {
  try {
    $root = [System.IO.Path]::GetPathRoot($Path)
    if (-not $root -or $root.StartsWith('\\')) { return -1.0 }
    return ((New-Object System.IO.DriveInfo($root)).AvailableFreeSpace / 1073741824)
  } catch { return -1.0 }
}

function Read-Verified {
  $script:Verified = @{}
  if (-not (Test-Path -LiteralPath $stateFile)) { return }
  try {
    $j = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $j.PSObject.Properties) { $script:Verified[$p.Name] = $p.Value }
  } catch { $script:Verified = @{} }
}

function Save-Verified {
  $o = [ordered]@{}
  foreach ($k in $script:Verified.Keys) { $o[$k] = $script:Verified[$k] }
  ($o | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

# SHA-256 of a file as lower-case hex (.NET directly: no module has to be loaded for it)
function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read, 1048576)
  try { $bytes = $sha.ComputeHash($stream) } finally { $stream.Dispose(); $sha.Dispose() }
  return ([System.BitConverter]::ToString($bytes).Replace('-', '')).ToLowerInvariant()
}

# SHA-256 of a file against the pinned value. A file that was checked before (same path, size and time) is not read again.
function Test-FileSha([string]$Path, [string]$Sha) {
  $fi = Get-Item -LiteralPath $Path
  $key = $fi.FullName.ToLowerInvariant()
  $want = $Sha.ToLowerInvariant()
  if ($script:Verified.ContainsKey($key)) {
    $rec = $script:Verified[$key]
    if ([long]$rec.size -eq $fi.Length -and [long]$rec.mtime -eq $fi.LastWriteTimeUtc.Ticks -and [string]$rec.sha256 -eq $want) { return $true }
  }
  $have = Get-Sha256 $Path
  if ($have -ne $want) { return $false }
  $script:Verified[$key] = @{ size = $fi.Length; mtime = $fi.LastWriteTimeUtc.Ticks; sha256 = $want }
  Save-Verified
  return $true
}

function New-Key {
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# ---------------------------------------------------------------------------------------------------------------- download

# https only; plain http is for the local test server of the tests
function Assert-DownloadUrl([string]$Url) {
  $uri = [System.Uri]$Url
  $local = ($uri.Host -eq '127.0.0.1' -or $uri.Host -eq 'localhost')
  if (-not ($uri.Scheme -eq 'https' -or ($uri.Scheme -eq 'http' -and $local))) { Fail ('Not downloading from ' + $Url + ' (https is required).') 1 }
}

function New-WebRequest([string]$Url) {
  $uri = [System.Uri]$Url
  $local = ($uri.Host -eq '127.0.0.1' -or $uri.Host -eq 'localhost')
  $req = [System.Net.HttpWebRequest]::Create($uri)
  $req.UserAgent = 'VideoEditor-LocalAI/1'
  $req.Timeout = 30000
  $req.ReadWriteTimeout = 60000
  $req.AllowAutoRedirect = $true
  $req.MaximumAutomaticRedirections = 8
  if ($local) { $req.Proxy = $null } else {
    # the proxy of Windows (also a script that picks one) and the sign-in of the user, as browsers do on company networks
    $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
    $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
    $req.Proxy = $proxy
  }
  return $req
}

function Show-Progress([string]$Label, [long]$Have, [long]$Total, [double]$Speed, [bool]$Done) {
  $pct = if ($Total -gt 0) { [int][math]::Floor(100.0 * $Have / $Total) } else { 0 }
  $eta = ''
  if ($Speed -gt 0 -and $Total -gt $Have) { $s = [int][math]::Ceiling(($Total - $Have) / $Speed); $eta = '  ' + ('{0}:{1:00}' -f [int][math]::Floor($s / 60), ($s % 60)) }
  $line = ('      {0}  {1,3}%  {2} / {3}  {4}/s{5}' -f $Label, $pct, (Format-Size $Have), (Format-Size $Total), (Format-Size $Speed), $eta)
  if ($script:OutRedirected) {
    if ($Done -or $pct -ge ($script:LastPct + 10)) { Write-Host $line; $script:LastPct = $pct }
    return
  }
  $width = 100
  try { $width = [Console]::WindowWidth - 1 } catch { }
  [Console]::Write("`r" + $line.PadRight([math]::Min($width, 200)))
  if ($Done) { [Console]::WriteLine() }
}

# Downloads Url to Dest. A partly downloaded file (Dest.part) is continued. Size = the pinned size (-1: unknown, always from the start).
# The caller checks the SHA-256 afterwards.
function Save-Download([string]$Url, [string]$Dest, [long]$Size, [string]$Label) {
  Assert-DownloadUrl $Url
  $part = $Dest + '.part'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dest) | Out-Null
  $buf = New-Object byte[] 1048576
  $failures = 0
  $script:LastPct = -10
  while ($true) {
    $have = 0L
    if ($Size -ge 0 -and (Test-Path -LiteralPath $part)) { $have = (Get-Item -LiteralPath $part).Length }
    if ($Size -ge 0 -and $have -gt $Size) { Remove-Item -LiteralPath $part -Force; $have = 0L }
    if ($Size -ge 0 -and $have -eq $Size) { break }
    $resp = $null; $in = $null; $out = $null
    $complete = $false
    try {
      $req = New-WebRequest $Url
      if ($have -gt 0) { $req.AddRange([long]$have) }
      $resp = $req.GetResponse()
      $append = $false
      if ($have -gt 0) { if ([int]$resp.StatusCode -eq 206) { $append = $true } else { $have = 0L } }
      $remaining = $resp.ContentLength
      if ($Size -ge 0 -and $remaining -ge 0 -and $remaining -ne ($Size - $have)) {
        $e = New-Object System.IO.InvalidDataException((T 'err.size' ($have + $remaining), $Size))
        throw $e
      }
      $total = if ($Size -ge 0) { $Size } elseif ($remaining -ge 0) { $remaining } else { 0L }
      $mode = if ($append) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }
      $out = New-Object System.IO.FileStream($part, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
      $in = $resp.GetResponseStream()
      $start = $have
      $clock = [System.Diagnostics.Stopwatch]::StartNew()
      $tick = 0L
      while ($true) {
        $n = $in.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $out.Write($buf, 0, $n)
        $have += $n
        if ($clock.ElapsedMilliseconds - $tick -ge 400) {
          $tick = $clock.ElapsedMilliseconds
          Show-Progress $Label $have $total ($(if ($clock.Elapsed.TotalSeconds -gt 0) { ($have - $start) / $clock.Elapsed.TotalSeconds } else { 0 })) $false
        }
      }
      $out.Flush()
      # a connection that ends early is not "complete": the part is kept and the next attempt continues after it
      $expectedEnd = -1L
      if ($Size -ge 0) { $expectedEnd = $Size } elseif ($remaining -ge 0) { $expectedEnd = $start + $remaining }
      if ($expectedEnd -ge 0 -and $have -lt $expectedEnd) { throw (New-Object System.IO.IOException('The connection was closed before the end of the file.')) }
      $complete = $true
      Show-Progress $Label $have $total ($(if ($clock.Elapsed.TotalSeconds -gt 0) { ($have - $start) / $clock.Elapsed.TotalSeconds } else { 0 })) $true
    } catch {
      $ex = $_.Exception
      while ($ex.InnerException -and -not ($ex -is [System.Net.WebException]) -and -not ($ex -is [System.IO.InvalidDataException])) { $ex = $ex.InnerException }
      if (-not $script:OutRedirected) { [Console]::WriteLine() }
      if ($ex -is [System.IO.InvalidDataException]) { if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }; Fail $ex.Message 3 }
      if ($ex -is [System.Net.WebException] -and $ex.Response) {
        $code = [int]$ex.Response.StatusCode
        if ($code -ge 400 -and $code -lt 500 -and $code -ne 408 -and $code -ne 429) { Fail ((T 'err.blocked' $code) + ' ' + $Url) 2 }
      }
      $failures++
      if ($failures -ge 6) {
        $hostName = ([System.Uri]$Url).Host
        Fail ((T 'err.net' $hostName, $ex.Message, $hostName)) 2
      }
      Say ('      ' + $ex.Message + ' - retrying (' + $failures + '/6)') 'Yellow'
      Start-Sleep -Milliseconds ([int](1000 * $script:RetryDelay * $failures))
    } finally {
      if ($in) { $in.Dispose() }
      if ($out) { $out.Dispose() }
      if ($resp) { $resp.Close() }
    }
    if ($complete) { break }
  }
  return $part
}

# ---------------------------------------------------------------------------------------------------------------- engine and model

function Test-Runtime([string]$Dir, $Want) {
  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return $false }
  foreach ($p in $Want.PSObject.Properties) {
    $f = Join-Path $Dir $p.Name
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $false }
    if (-not (Test-FileSha $f ([string]$p.Value))) { return $false }
  }
  return $true
}

# What to do by hand when a download is blocked: items = @( @{ url; dest } )
function Show-Manual($Items) {
  Say '' 'Gray'
  Say (T 'manual.title') 'Yellow'
  foreach ($i in $Items) { Say (T 'manual.file' ([string]$i.url), ([string]$i.dest)) 'Yellow' }
  Say (T 'manual.note') 'Yellow'
}

# "vk" (graphics card) or "cpu": downloads the pinned zip, checks it, unpacks only the files that are pinned, checks each of them
function Install-Runtime([string]$Kind) {
  $dir = Join-Path $runtimeRoot $Kind
  $want = $pins.llama.files.$Kind
  if (Test-Runtime $dir $want) { return $dir }
  $asset = $pins.llama.assets.$Kind
  $zip = Join-Path $downloadDir ('llama-' + [string]$pins.llama.tag + '-' + $Kind + '.zip')
  $part = $null
  # a zip saved there by hand (a network that blocks github.com) is used when it is the pinned one
  if ((Test-Path -LiteralPath $zip -PathType Leaf) -and ((Get-Sha256 $zip) -eq ([string]$asset.zipSha256).ToLowerInvariant())) { $part = $zip }
  if (-not $part) {
    try { $part = Save-Download ([string]$asset.url) $zip -1 ('llama.cpp ' + $Kind) } catch {
      if ($_.Exception.Data.Contains('code') -and [int]$_.Exception.Data['code'] -eq 2) { Show-Manual @(@{ url = [string]$asset.url; dest = $zip }) }
      throw
    }
  }
  try {
    $sha = Get-Sha256 $part
    if ($sha -ne ([string]$asset.zipSha256).ToLowerInvariant()) { Fail (T 'err.hash' ([string]$asset.url)) 3 }
    Say ('      ' + (T 'extracting')) 'DarkGray'
    $tmp = $dir + '.new'
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $za = [System.IO.Compression.ZipFile]::OpenRead($part)
    try {
      foreach ($e in $za.Entries) {
        $name = $e.FullName
        if (-not $name -or $name.Contains('/') -or $name.Contains('\')) { continue }
        if (-not $want.PSObject.Properties[$name]) { continue }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $tmp $name), $true)
      }
    } finally { $za.Dispose() }
    foreach ($p in $want.PSObject.Properties) {
      $f = Join-Path $tmp $p.Name
      if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Fail (T 'err.runtime' ($p.Name + ' is missing in the archive')) 3 }
      $h = Get-Sha256 $f
      if ($h -ne ([string]$p.Value).ToLowerInvariant()) { Fail (T 'err.hash' $p.Name) 3 }
    }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dir) | Out-Null
    Move-Item -LiteralPath $tmp -Destination $dir
  } finally {
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue }
  }
  if (-not (Test-Runtime $dir $want)) { Fail (T 'err.runtime' 'the files could not be verified after unpacking') 3 }
  return $dir
}

# Finds (or downloads) the model files; returns @{ model = path; mmproj = path }
function Install-Model {
  $found = @{}
  $missing = @()
  foreach ($f in $pins.model.files) {
    $path = $null
    $dirs = @($modelDir)
    if ($desktopModelDir) { $dirs += $desktopModelDir }
    $names = @([string]$f.name) + @($f.aliases | ForEach-Object { [string]$_ })
    foreach ($d in $dirs) {
      foreach ($n in $names) {
        $p = Join-Path $d $n
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
        if ((Get-Item -LiteralPath $p).Length -ne [long]$f.size) { continue }
        if (Test-FileSha $p ([string]$f.sha256)) { $path = $p; if ($d -ne $modelDir) { $script:ReusedFrom = $d }; break }
        # a damaged copy of our own folder is thrown away; the desktop app's folder is never touched
        if ($d -eq $modelDir) { Remove-Item -LiteralPath $p -Force }
      }
      if ($path) { break }
    }
    if ($path) { $found[[string]$f.role] = $path } else { $missing += $f }
  }
  if ($missing.Count -gt 0) {
    $need = 0L
    foreach ($f in $missing) { $need += [long]$f.size }
    $free = Get-FreeGb $modelDir
    if ($free -ge 0 -and ($free * 1073741824) -lt ($need + 300MB)) { Fail (T 'err.disk' ([System.IO.Path]::GetPathRoot($modelDir)), ([math]::Ceiling(($need + 300MB) / 1073741824 * 10) / 10), ([math]::Floor($free * 10) / 10)) 1 }
    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
    try {
      foreach ($f in $missing) {
        $dest = Join-Path $modelDir ([string]$f.name)
        Say ('      ' + (T 'downloading' ([string]$f.name))) 'Gray'
        $part = Save-Download ([string]$f.url) $dest ([long]$f.size) ([string]$f.role)
        Say ('      ' + (T 'verifying' (Format-Size ([long]$f.size)))) 'DarkGray'
        $h = Get-Sha256 $part
        if ($h -ne ([string]$f.sha256).ToLowerInvariant()) { Remove-Item -LiteralPath $part -Force; Fail (T 'err.hash' ([string]$f.name)) 3 }
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
        Move-Item -LiteralPath $part -Destination $dest
        if (-not (Test-FileSha $dest ([string]$f.sha256))) { Fail (T 'err.hash' ([string]$f.name)) 3 }
        $found[[string]$f.role] = $dest
      }
    } catch {
      if ($_.Exception.Data.Contains('code') -and [int]$_.Exception.Data['code'] -eq 2) {
        Show-Manual @($missing | ForEach-Object { @{ url = [string]$_.url; dest = (Join-Path $modelDir ([string]$_.name)) } })
      }
      throw
    }
  }
  return $found
}

# ---------------------------------------------------------------------------------------------------------------- the model server

function Get-Health([int]$PortNo) {
  $resp = $null
  try {
    $req = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:' + $PortNo + '/health')
    $req.Proxy = $null
    $req.Timeout = 2000
    $req.ReadWriteTimeout = 2000
    $resp = $req.GetResponse()
    return [int]$resp.StatusCode
  } catch {
    $ex = $_.Exception
    while ($ex.InnerException -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
    if ($ex -is [System.Net.WebException] -and $ex.Response) { $c = [int]$ex.Response.StatusCode; $ex.Response.Close(); return $c }
    return 0
  } finally { if ($resp) { $resp.Close() } }
}

function Find-FreePort([int]$From) {
  $used = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
  for ($p = $From; $p -lt $From + 60 -and $p -lt 65535; $p++) { if ($used -notcontains $p) { return $p } }
  return 0
}

# The graphics devices the Vulkan build can use: @( @{ Name; TotalMiB; FreeMiB } )
function Get-VkDevices([string]$Dir) {
  $exe = Join-Path $Dir $exeName
  $o = Join-Path $DataDir 'devices.out.log'
  $e = Join-Path $DataDir 'devices.err.log'
  $list = @()
  try {
    $p = Start-Process -FilePath $exe -ArgumentList '--list-devices' -WorkingDirectory $Dir -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
    $null = $p.Handle
    if (-not $p.WaitForExit(25000)) { try { Stop-Process -Id $p.Id -Force } catch { }; return $list }
    $text = ''
    foreach ($f in @($o, $e)) { if (Test-Path -LiteralPath $f) { $t = Get-Content -LiteralPath $f -Raw; if ($t) { $text += $t + "`n" } } }
    foreach ($m in [regex]::Matches($text, '(?m)^\s*(Vulkan\d+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$')) {
      $list += @{ Name = $m.Groups[2].Value; TotalMiB = [int]$m.Groups[3].Value; FreeMiB = [int]$m.Groups[4].Value }
    }
  } catch { }
  return $list
}

function Start-Model([string]$Kind, [int]$PortNo, [hashtable]$Model) {
  $dir = Join-Path $runtimeRoot $Kind
  $exe = Join-Path $dir $exeName
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { Fail (T 'err.exe' $exe, $runtimeRoot) 1 }
  # a new key for every start: a link, a log line or a command line that leaked is worthless once this window is closed. The key file lets a second
  # window open the page for the model that is running; it is removed when the model stops.
  $script:Key = New-Key
  Set-Content -LiteralPath $keyFile -Value $script:Key -Encoding ASCII
  $threads = [math]::Max(2, [math]::Min(12, [int][math]::Floor([Environment]::ProcessorCount / 2)))
  $ngl = if ($Kind -eq 'vk') { 99 } else { 0 }
  # same settings as the desktop app (src/main/llm/server.js)
  $argLine = ('-m "{0}" --mmproj "{1}" --host 127.0.0.1 --port {2} -c 24576 --parallel 2 --jinja --no-webui --no-slots --cache-ram 1024 -t {3} -ngl {4}' -f $Model.model, $Model.mmproj, $PortNo, $threads, $ngl)
  # the key and the template setting travel in the environment of the child only (not on its command line); nothing else of LLAMA_* is inherited
  foreach ($v in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'LLAMA_*' })) { Remove-Item -LiteralPath ('Env:\' + $v.Name) -ErrorAction SilentlyContinue }
  $env:LLAMA_API_KEY = $script:Key
  $env:LLAMA_ARG_CHAT_TEMPLATE_KWARGS = '{"enable_thinking":false}'
  try {
    $proc = Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $dir -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  } finally {
    Remove-Item -LiteralPath 'Env:\LLAMA_API_KEY' -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath 'Env:\LLAMA_ARG_CHAT_TEMPLATE_KWARGS' -ErrorAction SilentlyContinue
  }
  $null = $proc.Handle
  $script:Proc = $proc
  try { (@{ pid = $proc.Id; port = $PortNo; exe = $exe; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json) | Set-Content -LiteralPath $pidFile -Encoding UTF8 } catch { }
  return $proc
}

function Stop-Model {
  $p = $script:Proc
  $script:Proc = $null
  # nothing started by this window: nothing to stop, and the pid file (it may belong to a model that runs in another window) stays
  if (-not $p) { return }
  $id = $p.Id
  try { if (-not $p.HasExited) { Stop-Process -Id $id -Force -ErrorAction Stop } } catch { }
  try { $null = $p.WaitForExit(8000) } catch { }
  try {
    $rec = Get-Content -LiteralPath $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$rec.pid -eq $id) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
  } catch { }
  try { if ((Get-Content -LiteralPath $keyFile -Raw -Encoding ASCII).Trim() -eq $script:Key) { Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue } } catch { }
}

# 'ready' | 'exited' | 'timeout'
function Wait-Model($Proc, [int]$PortNo, [int]$TimeoutSec) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $spin = '|/-\'
  $i = 0
  while ($true) {
    if ($Proc.HasExited) { return 'exited' }
    if ((Get-Health $PortNo) -eq 200) { return 'ready' }
    if ($clock.Elapsed.TotalSeconds -gt $TimeoutSec) { return 'timeout' }
    if (-not $script:OutRedirected) { [Console]::Write("`r      " + $spin[$i % 4] + ' ' + [int]$clock.Elapsed.TotalSeconds + ' s   '); $i++ }
    Start-Sleep -Milliseconds 400
  }
}

# Whoever answers on the port must be the model we started: a program that grabbed the port first would otherwise be handed the key and the pictures.
# When Windows cannot tell, the start goes on.
function Test-Owner([int]$PortNo, [int]$ProcId) {
  try {
    $owners = @(Get-NetTCPConnection -State Listen -LocalPort $PortNo -ErrorAction Stop | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
    foreach ($o in $owners) { if ([int]$o -ne $ProcId) { return $false } }
    return $true
  } catch { return $true }
}

function Get-LogTail([string]$Path, [int]$Lines) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  try { return ((Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop) -join "`n").Replace($script:Key, '***') } catch { return '' }
}

# A model of an earlier run (the window was killed): running = reusable; anything else is stopped.
function Get-EarlierRun {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  try {
    $rec = Get-Content -LiteralPath $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $p = Get-Process -Id ([int]$rec.pid) -ErrorAction Stop
    $path = ''
    try { $path = [string]$p.Path } catch { }
    if (-not $path.StartsWith($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $pidFile -Force; return $null }
    return @{ Process = $p; Port = [int]$rec.port }
  } catch { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; return $null }
}

function Open-Page([string]$Url) {
  if ($NoBrowser) { return $true }
  try { Start-Process -FilePath $Url | Out-Null; return $true } catch { return $false }
}

# ---------------------------------------------------------------------------------------------------------------- main

$exitCode = 0
try {
  Say ''
  Say ('  ' + (T 'banner')) 'Cyan'
  Say ('  ' + ('-' * 44)) 'DarkGray'
  Say ('  ' + (T 'intro')) 'Gray'
  Say ''

  if ($Remove) {
    # only what this helper creates is deleted - never "everything in a folder" (the folder may be one the user chose)
    $items = @('models', 'runtime', 'downloads', 'key.txt', 'verified.json', 'llama-server.pid.json', 'llama-server.out.log', 'llama-server.err.log', 'devices.out.log', 'devices.err.log', '.video-editor-local-ai')
    $bytes = 0L
    foreach ($n in $items) {
      $p = Join-Path $DataDir $n
      if (Test-Path -LiteralPath $p -PathType Container) { Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $bytes += $_.Length } }
      elseif (Test-Path -LiteralPath $p -PathType Leaf) { $bytes += (Get-Item -LiteralPath $p).Length }
    }
    $earlier = Get-EarlierRun
    if ($bytes -eq 0 -and -not $earlier) { Say (T 'removeNone' $DataDir) 'Gray'; return }
    $answer = Read-Host (T 'removeAsk' $DataDir, ([math]::Round($bytes / 1073741824, 1)))
    if ($answer -notin @('YES', 'yes', 'EVET', 'evet')) { Say (T 'removeCancelled') 'Gray'; return }
    if ($earlier) { try { Stop-Process -Id $earlier.Process.Id -Force } catch { }; Start-Sleep -Milliseconds 800 }
    foreach ($n in $items) { Remove-Item -LiteralPath (Join-Path $DataDir $n) -Recurse -Force -ErrorAction SilentlyContinue }
    if ((Test-Path -LiteralPath $DataDir) -and -not (Get-ChildItem -LiteralPath $DataDir -Force)) { Remove-Item -LiteralPath $DataDir -Force -ErrorAction SilentlyContinue }
    Say (T 'removed') 'Green'
    return
  }

  if ($Stop) {
    $earlier = Get-EarlierRun
    if (-not $earlier) { Say (T 'notRunning') 'Gray'; return }
    # the window that runs it sees the flag, stops the model and ends; when nobody answers within a few seconds the model is stopped directly
    Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ASCII
    for ($w = 0; $w -lt 40 -and (Test-Path -LiteralPath $pidFile); $w++) { Start-Sleep -Milliseconds 250 }
    if (Test-Path -LiteralPath $pidFile) {
      try { Stop-Process -Id $earlier.Process.Id -Force; $null = $earlier.Process.WaitForExit(8000) } catch { }
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    Say (T 'stopped') 'Green'
    return
  }

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  if (-not (Test-Path -LiteralPath $markerFile)) { Set-Content -LiteralPath $markerFile -Value 'Video Editor - Local AI: files of the helper of the web edition (start-local-ai.cmd -Remove deletes them).' -Encoding ASCII }
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue

  Read-Verified

  $preferred = if ($Port -gt 0) { $Port } else { [int]$pins.defaultPort }

  # a model that is still running from an earlier run (its window was killed, or another window runs it): reused, with ITS key (key.txt)
  $earlier = Get-EarlierRun
  if ($earlier) {
    $earlierKey = ''
    if (Test-Path -LiteralPath $keyFile) { $earlierKey = (Get-Content -LiteralPath $keyFile -Raw -Encoding ASCII).Trim() }
    if (-not $PrepareOnly -and $earlier.Port -gt 0 -and (Get-Health $earlier.Port) -eq 200 -and ($Port -eq 0 -or $Port -eq $earlier.Port) -and $earlierKey -match '^[A-Za-z0-9_-]{16,128}$') {
      Say ('  ' + (T 'running' $earlier.Port)) 'Green'
      $url = $siteUri.GetLeftPart([System.UriPartial]::Path) + '#local-ai=' + $earlier.Port + '.' + $earlierKey
      if (-not $NoBrowser) { if (Open-Page $url) { Say ('  ' + (T 'opening')) 'Gray' } else { Say ('  ' + (T 'openFailed' $Site)) 'Yellow' } }
      return
    }
    try { Stop-Process -Id $earlier.Process.Id -Force; $null = $earlier.Process.WaitForExit(8000) } catch { }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
    Say ('  ' + (T 'stale')) 'Yellow'
  }

  # [1/3] the engine ------------------------------------------------------------------------------------------------
  # "vk" (graphics card) and "cpu" are unpacked on demand: the processor build only when the graphics build is not usable
  $have = @{}
  function Get-Runtime([string]$Kind) {
    if (-not $have.ContainsKey($Kind)) { $have[$Kind] = Install-Runtime $Kind }
    return $have[$Kind]
  }
  Say ('  [1/3] ' + (T 'step.engine' ([string]$pins.llama.tag))) 'White'
  if ($Backend -eq 'cpu') { $null = Get-Runtime 'cpu' }
  elseif ($Backend -eq 'vulkan') { $null = Get-Runtime 'vk' }
  else {
    try { $null = Get-Runtime 'vk' } catch {
      if ($_.Exception.Data.Contains('code') -and [int]$_.Exception.Data['code'] -eq 3) { throw }
      Say ('      ' + $_.Exception.Message) 'Yellow'
      $null = Get-Runtime 'cpu'
    }
  }
  Say ('      ' + (T 'okChecked')) 'Green'

  # [2/3] the model -------------------------------------------------------------------------------------------------
  Say ('  [2/3] ' + (T 'step.model' ([string]$pins.model.name))) 'White'
  $model = Install-Model
  if ($script:ReusedFrom) { Say ('      ' + (T 'okReused' $script:ReusedFrom)) 'Green' } else { Say ('      ' + (T 'okChecked')) 'Green' }

  if ($PrepareOnly) {
    if ($Backend -ne 'vulkan') { $null = Get-Runtime 'cpu' }
    Say ('  ' + (T 'prepared')) 'Green'
    return
  }

  # [3/3] start -----------------------------------------------------------------------------------------------------
  Say ('  [3/3] ' + (T 'step.start')) 'White'
  $modelBytes = 0L
  foreach ($f in $pins.model.files) { $modelBytes += [long]$f.size }
  try {
    $freeKb = [double](Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).FreePhysicalMemory
    if (($freeKb / 1048576) -lt ([double]$pins.model.needsRamGb)) { Say ('      ' + (T 'warn.ram' ([math]::Round($freeKb / 1048576, 1)), ([string]$pins.model.needsRamGb))) 'Yellow' }
  } catch { }

  # the graphics build when a graphics card has room for the model (as in the desktop app), the processor build otherwise and as the fallback
  $order = @()
  $gpuName = ''
  if ($have.ContainsKey('vk')) {
    if ($Backend -eq 'vulkan') { $order = @('vk') } else {
      $needMiB = [math]::Ceiling($modelBytes / 1048576) + 1500
      foreach ($d in @(Get-VkDevices $have['vk'])) { if ($d.FreeMiB -ge $needMiB) { $order += 'vk'; $gpuName = $d.Name; break } }
    }
  }
  if ($Backend -ne 'vulkan') { $order += 'cpu' }

  $portNo = Find-FreePort $preferred
  if ($portNo -eq 0) { Fail (T 'noPort' $preferred) 1 }
  if ($portNo -ne $preferred) { Say ('      ' + (T 'portBusy' $preferred, $portNo)) 'Yellow' }

  $ready = $false
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt $order.Count -and -not $ready; $i++) {
    $kind = $order[$i]
    $null = Get-Runtime $kind
    if ($kind -eq 'vk') { Say ('      ' + (T 'gpu' ($(if ($gpuName) { $gpuName } else { 'Vulkan' })))) 'DarkGray' } else { Say ('      ' + (T 'cpu')) 'DarkGray' }
    $proc = Start-Model $kind $portNo $model
    $state = Wait-Model $proc $portNo 300
    if (-not $script:OutRedirected) { [Console]::Write("`r" + (' ' * 40) + "`r") }
    if ($state -eq 'ready') {
      if (-not (Test-Owner $portNo $proc.Id)) { Stop-Model; Fail (T 'err.owner' $portNo) 1 }
      $ready = $true
      break
    }
    $tail = Get-LogTail $errLog 12
    Stop-Model
    if ($i + 1 -lt $order.Count) { Say ('      ' + (T 'gpuFailed')) 'Yellow'; continue }
    $why = if ($state -eq 'timeout') { T 'err.timeout' 300 } else { T 'err.start' $kind }
    if ($tail) { Say $tail 'DarkGray' }
    Fail ($why + ' ' + (T 'err.log' $errLog)) 1
  }
  $script:Started = $true

  $seconds = [int][math]::Round($clock.Elapsed.TotalSeconds)
  Say ''
  Say ('  ' + (T 'ready' $portNo, $seconds)) 'Green'
  $pairUrl = $siteUri.GetLeftPart([System.UriPartial]::Path) + '#local-ai=' + $portNo + '.' + $script:Key
  if (-not $NoBrowser) { if (Open-Page $pairUrl) { Say ('  ' + (T 'opening')) 'Gray' } else { Say ('  ' + (T 'openFailed' $Site)) 'Yellow' } }
  Say ('  ' + (T 'hotkeys')) 'DarkGray'
  Say ''

  $stop = $false
  while (-not $stop) {
    if ($script:Proc -eq $null -or $script:Proc.HasExited) { break }
    if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue; $stop = $true; break }
    if ($script:Interactive) {
      try {
        while ([Console]::KeyAvailable) {
          $k = [Console]::ReadKey($true)
          if ($k.Key -eq [System.ConsoleKey]::Enter) { $stop = $true }
          elseif ($k.Key -eq [System.ConsoleKey]::L) { $null = Open-Page $pairUrl }
          elseif ($k.Key -eq [System.ConsoleKey]::K) { Say ('  ' + (T 'key' $portNo, $script:Key)) 'Yellow' }
        }
      } catch { $script:Interactive = $false }
    }
    Start-Sleep -Milliseconds 300
  }
  if (-not $stop -and $script:Proc -ne $null -and $script:Proc.HasExited) {
    Say ('  ' + (T 'err.start' ('exit ' + $script:Proc.ExitCode))) 'Red'
    $tail = Get-LogTail $errLog 12
    if ($tail) { Say $tail 'DarkGray' }
    $exitCode = 1
  }
} catch {
  $ex = $_.Exception
  Say ''
  Say ('  ' + $ex.Message) 'Red'
  if ($ex.Data.Contains('code')) { $exitCode = [int]$ex.Data['code'] } else { $exitCode = 1 }
  if ($ex.GetType().FullName -ne 'System.Exception') { Say ('  ' + $_.ScriptStackTrace) 'DarkGray' }
} finally {
  Stop-Model
  $script:Key = ''
  if ($script:Started -and $exitCode -eq 0) { Say ('  ' + (T 'stopped')) 'Gray' }
  try { if ($script:OldEncoding) { [Console]::OutputEncoding = $script:OldEncoding } } catch { }
}
exit $exitCode
