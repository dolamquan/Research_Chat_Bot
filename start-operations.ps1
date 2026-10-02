# Launch the standalone Research Ops frontend. The chatbot API stays on :8002.
param([int]$Port = 5174, [switch]$PreviewData)
$ErrorActionPreference = 'Stop'
$operationsDirectory = Join-Path $PSScriptRoot 'operations'
if (-not (Test-Path -LiteralPath (Join-Path $operationsDirectory 'node_modules/vite')) -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'frontend/node_modules/vite'))) {
    throw 'Install dependencies first: cd operations; npm install'
}
Write-Host "Research Ops: http://127.0.0.1:$Port" -ForegroundColor Green
if ($PreviewData) { Write-Host "Sample data: http://127.0.0.1:$Port/?demo=1" -ForegroundColor Cyan }
Write-Host 'Uses the chatbot API on port 8002. Restart that backend once to enable telemetry.'
Push-Location $operationsDirectory
try { node scripts/run.mjs dev --port $Port }
finally { Pop-Location }
