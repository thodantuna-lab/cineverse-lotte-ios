param(
  [Parameter(Mandatory = $true)]
  [string]$InputVideo,

  [string]$OutputDir = ""
)

if (-not (Test-Path $InputVideo)) {
  Write-Error "Khong tim thay file video: $InputVideo"
  exit 1
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Error "Can cai dat ffmpeg truoc khi chuyen doi HLS (https://ffmpeg.org/)."
  exit 1
}

$baseName = [System.IO.Path]::GetFileNameWithoutExtension($InputVideo)
if (-not $OutputDir) {
  $OutputDir = Join-Path (Split-Path $InputVideo -Parent) ($baseName + "_hls")
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$playlistPath = Join-Path $OutputDir "index.m3u8"
$segmentPattern = Join-Path $OutputDir "seg_%04d.ts"

Write-Host "Dang chuyen doi sang HLS (5 giay/doan) tai: $OutputDir"
ffmpeg -y -i $InputVideo `
  -c:v copy -c:a aac -b:a 192k `
  -hls_time 5 `
  -hls_playlist_type vod `
  -hls_segment_filename $segmentPattern `
  $playlistPath

if ($LASTEXITCODE -eq 0) {
  Write-Host "Hoan tat! Hay tai toan bo thu muc '$OutputDir' len Cloudflare R2 va dan link '.../index.m3u8' vao phong chieu."
}
