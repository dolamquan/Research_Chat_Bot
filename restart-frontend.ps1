# Restart the ResearchMind frontend on :5173 with a clean dependency cache.
#
# Use this after dependencies change. Vite pre-bundles node_modules into
# node_modules/.vite with hashed chunk names; when the dependency set changes
# it re-bundles under new hashes, and a browser tab still holding the old
# module graph can fail to resolve imports. Clearing the cache and
# hard-reloading fixes that.
#
# Note: a "<name> is not defined" ReferenceError blamed on a .vite/deps chunk
# is usually NOT a cache problem -- React attributes render-time errors to the
# nearest component boundary, so a missing symbol in our own source gets
# reported against whatever library component was rendering. Grep src/ for the
# identifier before clearing anything.
#
#   cd "C:\Users\jackd\OneDrive\Documents\AI Engineer\Research-chatbot"
#   .\restart-frontend.ps1
#
# Then HARD reload the browser (Ctrl+Shift+R) so it drops the stale chunks.

$ErrorActionPreference = 'Stop'
$port = 5173
$frontend = Join-Path $PSScriptRoot 'frontend'

$held = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $held) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "stopping existing dev server: PID $($proc.Id)" -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force
    }
}

if ($held) {
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
    }
}

$cache = Join-Path $frontend 'node_modules\.vite'
if (Test-Path $cache) {
    Write-Host "clearing dependency cache" -ForegroundColor Yellow
    Remove-Item -Recurse -Force $cache
}

Write-Host "starting Vite (first start re-bundles deps, so it is slower)" -ForegroundColor Green
Write-Host "remember to HARD reload the browser: Ctrl+Shift+R" -ForegroundColor Cyan
Set-Location $frontend
pnpm run dev
