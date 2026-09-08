# Deploy update assets to Tencent COS (bucket xivstrat-1252502193, ap-guangzhou, prefix mlbosstimer/)
# Design (CDN node cache = 1 year, query string IS part of EdgeOne cache key - verified):
#   manifest.json -> CDN + unique ?t=<ms> per check (client always appends it -> always fresh from origin)
#   setup exe     -> CDN (versioned filename, 1-year cache is a feature, saves COS egress)
#
# Usage:   .\scripts\deploy_update.ps1 -NotesZh "<zh notes>" -NotesEn "<en notes>"
# Creds:   env COS_SECRET_ID / COS_SECRET_KEY for this session (or run coscmd config once manually)
# Depends: pip install coscmd
param(
  [string]$NotesZh = "",
  [string]$NotesEn = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$COS_REGION = "ap-guangzhou"
$COS_BUCKET = "xivstrat-1252502193"
$CDN_BASE   = "https://cos.xivstrat.cn/mlbosstimer"

# ---- version ----
$conf = Get-Content "$root\shell\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$ver = $conf.version
$setupSrc = "$root\shell\src-tauri\target\release\bundle\nsis\MapleLegends Boss Timer_${ver}_x64-setup.exe"
if (!(Test-Path $setupSrc)) {
  Write-Host "!! setup exe not found: $setupSrc (run: cd shell; npx tauri build)" -ForegroundColor Red
  exit 1
}

# ---- stage ----
$stage = "$root\release\cos"
New-Item -ItemType Directory -Force $stage | Out-Null
$setupName = "mlboss-timer_${ver}_x64-setup.exe"
Copy-Item $setupSrc "$stage\$setupName" -Force
$sha256 = (Get-FileHash "$stage\$setupName" -Algorithm SHA256).Hash.ToLower()

if (!$NotesZh) { $NotesZh = "v$ver update" }
if (!$NotesEn) { $NotesEn = "v$ver update" }

# ---- manifest ----
$manifest = @{
  version  = $ver
  setup    = "$CDN_BASE/$setupName"
  sha256   = $sha256
  notes_zh = $NotesZh
  notes_en = $NotesEn
} | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$stage\manifest.json", $manifest, $utf8NoBom)
Write-Host "manifest: v$ver sha256=$($sha256.Substring(0,12))..."

# ---- creds ----
if ($env:COS_SECRET_ID -and $env:COS_SECRET_KEY) {
  coscmd config -a $env:COS_SECRET_ID -s $env:COS_SECRET_KEY -r $COS_REGION -b $COS_BUCKET
  if ($LASTEXITCODE -ne 0) { Write-Host "!! coscmd config failed" -ForegroundColor Red; exit 1 }
}

# ---- upload ----
Write-Host "uploading manifest.json + $setupName -> COS mlbosstimer/ ..."
coscmd upload "$stage\manifest.json" "mlbosstimer/manifest.json"
if ($LASTEXITCODE -ne 0) { Write-Host "!! manifest upload failed (coscmd configured?)" -ForegroundColor Red; exit 1 }
coscmd upload "$stage\$setupName" "mlbosstimer/$setupName"
if ($LASTEXITCODE -ne 0) { Write-Host "!! setup upload failed" -ForegroundColor Red; exit 1 }

# ---- verify ----
$t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
  $r = Invoke-WebRequest "$CDN_BASE/manifest.json?t=$t" -UseBasicParsing -TimeoutSec 20
  $m = $r.Content | ConvertFrom-Json
  if ($m.version -eq $ver) { Write-Host "OK: manifest live on CDN (v$ver)" -ForegroundColor Green }
  else { Write-Host "!! CDN returned stale version ($($m.version))" -ForegroundColor Yellow }
} catch {
  Write-Host "!! manifest verify failed: $($_.Exception.Message)" -ForegroundColor Yellow
}
try {
  $r2 = Invoke-WebRequest "$CDN_BASE/$setupName" -Method Head -UseBasicParsing -TimeoutSec 60
  $lenRaw = @($r2.Headers.'Content-Length')[0]
  $len = [math]::Round([double]$lenRaw/1MB, 1)
  Write-Host "OK: setup reachable on CDN ($len MB)" -ForegroundColor Green
} catch {
  Write-Host "!! setup verify failed (CDN warmup may take a moment): $($_.Exception.Message)" -ForegroundColor Yellow
}
