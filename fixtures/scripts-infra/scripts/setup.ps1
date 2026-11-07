<# $env:IN_BLOCK_COMMENT #>
$env:SETUP_MODE = "full"
Write-Host "Mode: $env:SETUP_MODE and $env:AWS_REGION" # $env:IN_COMMENT
$token = [Environment]::GetEnvironmentVariable("GH_TOKEN")
[Environment]::SetEnvironmentVariable("CACHE_DIR", "x")
& ./scripts/deploy.sh
pwsh -File ./scripts/setup2.ps1
