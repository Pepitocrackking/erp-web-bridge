# Control del sandbox de Saint (SQL Server en Docker). Variante PowerShell de saint-sandbox.sh. (Solo ASCII: PowerShell 5.1 lee mal UTF-8 sin BOM.)
# Uso: powershell -File scripts\saint-sandbox.ps1 {up|reset|mutate|checksum|down}
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'reset', 'mutate', 'checksum', 'down')]
    [string]$Command = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Root 'infra\saint-sandbox\tools'
Set-Location $Root

function Invoke-Native {
    # Ejecuta un comando nativo y falla si el codigo de salida no es 0.
    param([string]$Exe, [string[]]$Arguments)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') termino con codigo $LASTEXITCODE" }
}

function Invoke-SqlFile {
    # Copia el .sql al contenedor y lo ejecuta con -i (evita problemas de codificacion al canalizar por stdin).
    param([string]$Path)
    Invoke-Native docker @('cp', $Path, 'saint-sql:/tmp/run.sql')
    docker exec saint-sql bash -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -b -i /tmp/run.sql'
    if ($LASTEXITCODE -ne 0) { throw "sqlcmd fallo con codigo $LASTEXITCODE" }
}

function Wait-SaintReady {
    for ($i = 0; $i -lt 60; $i++) {
        $status = docker inspect -f '{{.State.Health.Status}}' saint-sql 2>$null
        if ($status -eq 'healthy') { return }
        Start-Sleep -Seconds 2
    }
    throw 'saint-sql no llego a healthy'
}

function Invoke-SaintInit { Invoke-Native docker @('compose', 'run', '--rm', 'saint-init') }

switch ($Command) {
    'up' {
        if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host 'Creado .env desde .env.example' }
        Invoke-Native docker @('compose', 'up', '-d', 'saint-sql')
        Wait-SaintReady
        Invoke-SaintInit
        Write-Host 'Sandbox listo en localhost:14330 (base SAINT_DEMO)'
    }
    'reset' {
        Wait-SaintReady
        Invoke-SqlFile (Join-Path $Tools 'reset.sql')
        Invoke-SaintInit
        Write-Host 'Sandbox restaurado al seed original'
    }
    'mutate' {
        Wait-SaintReady
        Invoke-SqlFile (Join-Path $Tools 'mutate.sql')
        Write-Host 'Mutaciones aplicadas'
    }
    'checksum' {
        Wait-SaintReady
        Invoke-SqlFile (Join-Path $Tools 'checksum.sql')
    }
    'down' { Invoke-Native docker @('compose', 'down') }
    default {
        Write-Error 'Uso: saint-sandbox.ps1 {up|reset|mutate|checksum|down}'
        exit 2
    }
}
