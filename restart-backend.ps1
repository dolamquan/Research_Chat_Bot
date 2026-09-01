# Restart the Zoetrope backend on :8002 with auto-reload.
#
# Run this yourself rather than letting Claude do it: AVG intercepts TLS for
# processes Claude spawns, so a backend it launches cannot reach OpenAI. A
# backend you launch can.
#
#   cd "C:\Users\jackd\OneDrive\Documents\AI Engineer\Research-chatbot"
#   .\restart-backend.ps1

$ErrorActionPreference = 'Stop'
$port = 8002
$backend = Join-Path $PSScriptRoot 'backend'

# Whatever is already holding the port has to go first: uvicorn exits
# immediately on a socket conflict, which makes a restart look like a no-op.
$held = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $held) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "stopping existing backend: PID $($proc.Id)" -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force
    }
}

if ($held) {
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
    }
}

if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "port $port is still held; cannot start" -ForegroundColor Red
    exit 1
}

Write-Host "starting backend with --reload (Ctrl+C to stop)" -ForegroundColor Green
Set-Location $backend
python -m uvicorn app.main:app --host 127.0.0.1 --port $port --reload
