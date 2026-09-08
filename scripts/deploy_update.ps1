# 发布更新资产到腾讯云 COS (mlbosstimer/ 前缀, EdgeOne 加速域名 cos.xivstrat.cn)
# 用法: .\scripts\deploy_update.ps1 [-NotesZh "说明"] [-NotesEn "notes"]
# 依赖: coscmd (pip install coscmd) + 一次性配置 (见下方说明)
#
# 一次性配置 (二选一):
#   A. 环境变量: 设置 COS_SECRET_ID / COS_SECRET_KEY / COS_REGION / COS_BUCKET 后运行本脚本自动写入
#   B. 手动: coscmd config -a <SecretId> -s <SecretKey> -r <region如ap-guangzhou> -b <bucket名-appid>
#
# 流程: 取 tauri.conf.json 版本 → 重命名安装包副本 → 算 sha256 → 生成 manifest.json → 上传两个文件 → 验证 URL 可访问
param(
  [string]$NotesZh = "",
  [string]$NotesEn = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

# ---- 读取版本号 ----
$conf = Get-Content "$root\shell\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$ver = $conf.version
$setupSrc = "$root\shell\src-tauri\target\release\bundle\nsis\MapleLegends Boss Timer_${ver}_x64-setup.exe"
if (!(Test-Path $setupSrc)) {
  Write-Host "!! 安装包不存在: $setupSrc (先 npx tauri build)" -ForegroundColor Red
  exit 1
}

# ---- 暂存目录 ----
$stage = "$root\release\cos"
New-Item -ItemType Directory -Force $stage | Out-Null
$setupName = "mlboss-timer_${ver}_x64-setup.exe"
Copy-Item $setupSrc "$stage\$setupName" -Force
$sha256 = (Get-FileHash "$stage\$setupName" -Algorithm SHA256).Hash.ToLower()

if (!$NotesZh) { $NotesZh = "v$ver 更新" }
if (!$NotesEn) { $NotesEn = "v$ver update" }

# ---- manifest ----
$base = "https://cos.xivstrat.cn/mlbosstimer"
$manifest = @{
  version = $ver
  setup   = "$base/$setupName"
  sha256  = $sha256
  notes_zh = $NotesZh
  notes_en = $NotesEn
} | ConvertTo-Json
Set-Content "$stage\manifest.json" $manifest -Encoding UTF8
Write-Host "manifest: v$ver sha256=$($sha256.Substring(0,12))…"

# ---- COS 凭证: 环境变量 → 首次自动配置 ----
if ($env:COS_SECRET_ID -and $env:COS_SECRET_KEY -and $env:COS_REGION -and $env:COS_BUCKET) {
  coscmd config -a $env:COS_SECRET_ID -s $env:COS_SECRET_KEY -r $env:COS_REGION -b $env:COS_BUCKET
  if ($LASTEXITCODE -ne 0) { Write-Host "!! coscmd 配置失败" -ForegroundColor Red; exit 1 }
}

# ---- 上传 ----
Write-Host "上传 $setupName + manifest.json → COS mlbosstimer/ ..."
coscmd upload "$stage\$setupName" "mlbosstimer/$setupName"
if ($LASTEXITCODE -ne 0) { Write-Host "!! 安装包上传失败 (coscmd 已配置? 见脚本头部说明)" -ForegroundColor Red; exit 1 }
coscmd upload "$stage\manifest.json" "mlbosstimer/manifest.json"
if ($LASTEXITCODE -ne 0) { Write-Host "!! manifest 上传失败" -ForegroundColor Red; exit 1 }

# ---- 验证 (带时间戳破缓存) ----
$t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
  $r = Invoke-WebRequest "$base/manifest.json?t=$t" -UseBasicParsing -TimeoutSec 20
  $m = $r.Content | ConvertFrom-Json
  if ($m.version -eq $ver) { Write-Host "OK: manifest 已生效 (v$ver)" -ForegroundColor Green }
  else { Write-Host "!! CDN 返回旧版本 ($($m.version)), 稍后重试或刷新 CDN 缓存" -ForegroundColor Yellow }
} catch {
  Write-Host "!! 验证失败: $($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host "完成: $base/manifest.json"
