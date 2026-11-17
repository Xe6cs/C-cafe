# Starts/stops the isolated PostgreSQL cluster used by npm run test:db:real.
#
# This script is deliberately separate from the machine's existing PostgreSQL
# service: it uses its own data directory and a non-standard port (55432 by
# default). It never starts, stops, or deletes the existing service or its data.
#
# Usage:
#   powershell -File supabase/tests/local-pg.ps1 -Action start
#   powershell -File supabase/tests/local-pg.ps1 -Action status
#   powershell -File supabase/tests/local-pg.ps1 -Action stop
#
# Override if needed:
#   $env:CCAFE_PG_BIN = 'C:\Program Files\PostgreSQL\16\bin'
#   -Port 55433 -Root 'C:\Users\you\AppData\Local\ccafe-pg-verify'

param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'status',
  [int]$Port = 55432,
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'ccafe-pg-verify')
)

$ErrorActionPreference = 'Stop'

if ($Port -eq 5432) {
  throw 'Refusing port 5432; that is the existing PostgreSQL service. Use the isolated port 55432.'
}

$bin = $env:CCAFE_PG_BIN
if (-not $bin) {
  $bin = @(
    'C:\Program Files\PostgreSQL\16\bin',
    'C:\Program Files\PostgreSQL\17\bin',
    'C:\Program Files\PostgreSQL\15\bin'
  ) | Where-Object { Test-Path (Join-Path $_ 'pg_ctl.exe') } | Select-Object -First 1
}
if (-not $bin) {
  throw 'PostgreSQL binaries were not found. Set CCAFE_PG_BIN to the folder that contains pg_ctl.exe.'
}

$data = Join-Path $Root 'data'
$pgCtl = Join-Path $bin 'pg_ctl.exe'

function Assert-NotRunningFromExistingService {
  if (Test-Path (Join-Path $data 'postmaster.pid')) {
    $pidLine = Get-Content (Join-Path $data 'postmaster.pid') -First 1
    Write-Output "Isolated cluster PID file: $pidLine"
  }
}

switch ($Action) {
  'start' {
    if (-not (Test-Path $data)) {
      New-Item -ItemType Directory -Force $Root | Out-Null
      & (Join-Path $bin 'initdb.exe') -D $data -U ccafe_admin --auth=trust --encoding=UTF8 --locale=C --no-sync
      if ($LASTEXITCODE -ne 0) { throw 'initdb failed.' }
    }

    & $pgCtl -D $data status *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Output 'Isolated PostgreSQL is already running.'
      Assert-NotRunningFromExistingService
      break
    }

    $process = Start-Process -FilePath (Join-Path $bin 'postgres.exe') `
      -ArgumentList @('-D', $data, '-p', "$Port", '-c', 'listen_addresses=127.0.0.1') `
      -RedirectStandardOutput (Join-Path $Root 'server.out.log') `
      -RedirectStandardError (Join-Path $Root 'server.err.log') `
      -PassThru -WindowStyle Hidden

    Start-Sleep -Seconds 2
    & (Join-Path $bin 'psql.exe') -h 127.0.0.1 -p $Port -U ccafe_admin -d postgres -Atc 'select version();'
    if ($LASTEXITCODE -ne 0) { throw 'Isolated PostgreSQL did not start.' }
    Write-Output "Started PID $($process.Id) on 127.0.0.1:$Port (data: $data)."
  }
  'stop' {
    if (-not (Test-Path $data)) {
      Write-Output 'No isolated cluster data directory; nothing to stop.'
      break
    }
    & $pgCtl -D $data -m fast stop
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the isolated cluster.' }
  }
  'status' {
    if (-not (Test-Path $data)) {
      Write-Output 'No isolated cluster data directory yet.'
      break
    }
    & $pgCtl -D $data status
    if ($LASTEXITCODE -ne 0) { Write-Output 'Isolated PostgreSQL is not running.' }
  }
}
