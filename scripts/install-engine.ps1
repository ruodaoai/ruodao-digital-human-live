param(
  [ValidateSet("wav2lip", "musetalk", "livetalking")]
  [string]$Target = "wav2lip",
  [switch]$Clone,
  [switch]$Install
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $root "engine"
$thirdParty = Join-Path $engineDir "third_party"
$venv = Join-Path $engineDir ".venv"

Write-Host "== 数字人直播 · 本地开源引擎预检 ==" -ForegroundColor Cyan

$gpu = $null
try {
  $gpu = nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>$null
} catch { }
if ($gpu) {
  Write-Host "GPU: $gpu" -ForegroundColor Green
  $vram = 0
  if ($gpu -match "(\d+)\s*MiB") { $vram = [int]$matches[1] / 1024 }
  if ($vram -lt 8) {
    Write-Host "提示：显存约 $([math]::Round($vram,1))GB，MuseTalk 会吃紧，建议 Wav2Lip，或继续用零依赖静态真人模式。" -ForegroundColor Yellow
  }
} else {
  Write-Host "未检测到 NVIDIA 显卡。" -ForegroundColor Yellow
  Write-Host "本地开源口型引擎需要 CUDA；没有显卡请使用插件默认的「静态真人」模式，传图即可开播。" -ForegroundColor Yellow
}

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
Write-Host "python: $(if ($py) { $py } else { '未安装' })"
Write-Host "git:    $(if ($git) { $git } else { '未安装' })"

if (-not $py) {
  Write-Host "请先安装 Python 3.10 / 3.11（PyTorch 对 3.12 的部分组合仍不稳定）。" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "== 方案对比 ==" -ForegroundColor Cyan
Write-Host "Wav2Lip    约 2GB 显存即可实时，兼容性最好，口型清晰度一般，适合 6GB 显卡。"
Write-Host "MuseTalk   口型质量明显更好，官方建议 8GB+ 显存，6GB 需 fp16 + 降低 batch。"
Write-Host "LiveTalking 一套实时流式框架，内置 MuseTalk / Wav2Lip / ER-NeRF 后端，支持 WebRTC。"
Write-Host ""
Write-Host "共同边界：它们只做口型，不做大范围头部动作；要点头/摆头需再叠加 LivePortrait。"
Write-Host ""

if (-not $Clone -and -not $Install) {
  Write-Host "当前仅做预检。确认要继续时执行：" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/install-engine.ps1 -Target livetalking -Clone"
  Write-Host ""
  Write-Host "如果只想立刻开播，不需要这一步：插件默认的静态真人模式已经可用。" -ForegroundColor Green
  exit 0
}

if (-not $git) {
  Write-Host "需要 git 才能拉取开源仓库，请先安装 Git。" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $thirdParty | Out-Null

if ($Clone) {
  $repo = switch ($Target) {
    "musetalk" { "https://github.com/TMElyralab/MuseTalk" }
    "livetalking" { "https://github.com/lipku/LiveTalking" }
    default { "https://github.com/Rudrabha/Wav2Lip" }
  }
  $name = ($repo -split "/")[-1]
  $dest = Join-Path $thirdParty $name
  if (Test-Path $dest) {
    Write-Host "已存在：$dest（跳过克隆）" -ForegroundColor Yellow
  } else {
    Write-Host "克隆 $repo ..." -ForegroundColor Cyan
    git clone --depth 1 $repo $dest
  }
  Write-Host ""
  Write-Host "模型权重需要按各自仓库说明单独下载（通常 300MB - 3GB），放到：$dest" -ForegroundColor Yellow
}

if ($Install) {
  Write-Host "创建 Python 虚拟环境：$venv" -ForegroundColor Cyan
  if (-not (Test-Path $venv)) { & $py -m venv $venv }
  $venvPy = Join-Path $venv "Scripts\python.exe"
  & $venvPy -m pip install --upgrade pip
  Write-Host "提示：具体推理依赖请按所选仓库的 requirements.txt 安装，例如：" -ForegroundColor Yellow
  Write-Host "  $venvPy -m pip install -r $thirdParty\<repo>\requirements.txt"
}

Write-Host ""
Write-Host "完成预检。把插件「渲染引擎」切到 local，地址填 http://127.0.0.1:8090（或你的服务端口）。" -ForegroundColor Green