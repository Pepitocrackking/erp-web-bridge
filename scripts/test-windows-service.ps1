<#
.SYNOPSIS
  Prueba real del servicio de Windows del agente: instalar, arrancar, sincronizar,
  recuperarse de una caída, detener y desinstalar.

.DESCRIPTION
  Necesita PowerShell como administrador, la API corriendo (por defecto en
  http://localhost:3001) y Supabase local con el seed (organización demo-mock).
  Usa el ERP simulado (mock), un nombre de servicio propio (ErpAgentTest) y una
  carpeta temporal en C:\ProgramData; al terminar lo borra todo.

  Salida: una línea por comprobación (OK / FALLO) y código de salida 0 solo si todas pasan.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\test-windows-service.ps1
  powershell -ExecutionPolicy Bypass -File scripts\test-windows-service.ps1 -Exe C:\ruta\erp-agent.exe
#>
param(
  [string]$Exe = "",
  [string]$ApiUrl = "http://localhost:3001",
  [string]$ApiKey = "erp_dev_demo_mock_key",
  [string]$OrgSlug = "demo-mock",
  [string]$ServiceName = "ErpAgentTest",
  [string]$DbContainer = "supabase_db_erp-web-bridge"
)
# "Continue" y no "Stop": en Windows PowerShell 5.1 el stderr de un .exe redirigido con 2>&1 se vuelve
# una excepción con "Stop", y varias comprobaciones esperan justamente que el agente falle con un mensaje.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
$failures = 0
function Check($ok, $msg, $detail = "") {
  if ($ok) { Write-Host "OK     $msg" } else { Write-Host "FALLO  $msg  $detail"; $script:failures++ }
}
function Wait-Until([scriptblock]$cond, [int]$seconds, [int]$every = 1) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Seconds $every }
  return $false
}
function ServiceExists { $null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "Esta prueba necesita PowerShell como administrador."; exit 2 }

$work = Join-Path $env:ProgramData "ErpAgentTest"
$agent = Join-Path $work "erp-agent.exe"
$cfg = Join-Path $work "agent.yaml"
$dataDir = Join-Path $work "data"
$log = Join-Path $dataDir "erp-agent.log"
if (ServiceExists) { Write-Host "Ya existe un servicio $ServiceName (¿restos de una corrida anterior?). Desinstálalo antes."; exit 2 }

try {
  # 0. Preparación: binario y configuración en una carpeta propia.
  if (Test-Path $work) { Remove-Item -Recurse -Force $work }
  New-Item -ItemType Directory -Path $work | Out-Null
  if ($Exe -eq "") {
    Push-Location (Join-Path $repo "packages\erp-agent")
    $env:CGO_ENABLED = "0"
    go build -o $agent .\cmd\erp-agent
    if ($LASTEXITCODE -ne 0) { throw "falló go build" }
    Pop-Location
  } else { Copy-Item $Exe $agent }
  @"
api: { url: "$ApiUrl", api_key: "$ApiKey" }
erp: { type: mock, mock: { products: 20, customers: 5, seed: 7 } }
sync: { interval: 5s, reconcile_interval: 0s }
heartbeat: { interval: 5s }
store: { path: data/agent.db }
log: { level: info, format: json }
"@ | Set-Content -Path $cfg -Encoding ascii

  # 1. Configuración inválida: se rechaza sin instalar nada.
  $bad = Join-Path $work "mala.yaml"
  "api: { url: 'http://remoto.com' }`nerp: { type: raro }" | Set-Content $bad -Encoding ascii
  & $agent service install -name $ServiceName -config $bad 2>&1 | Out-Null
  Check (($LASTEXITCODE -ne 0) -and -not (ServiceExists)) "una configuración inválida no instala nada"

  # 2. Instalar.
  & $agent service install -name $ServiceName -config $cfg
  Check (($LASTEXITCODE -eq 0) -and (ServiceExists)) "service install crea el servicio"
  $again = & $agent service install -name $ServiceName -config $cfg 2>&1
  Check ($LASTEXITCODE -ne 0) "instalar dos veces falla con un mensaje claro" ($again -join " ")

  $svcInfo = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  Check ($svcInfo.StartMode -eq "Auto") "arranque automático" $svcInfo.StartMode
  Check ($svcInfo.StartName -eq "NT AUTHORITY\LocalService") "corre como LocalService, no como SYSTEM" $svcInfo.StartName
  Check ($svcInfo.PathName -notmatch "secreta|api_key|dsn|password" -and $svcInfo.PathName -notmatch [regex]::Escape($ApiKey)) "la línea de comandos no contiene secretos" $svcInfo.PathName
  # La salida de sc.exe está traducida (REINICIAR, VERDADERO...): se comparan los números, no las palabras.
  $failure = sc.exe qfailure $ServiceName | Out-String
  $delays = ([regex]::Matches($failure, "(\d+)\s*ms") | ForEach-Object { [int]$_.Groups[1].Value }) -join ","
  Check ($delays -eq "5000,15000,60000") "recuperación: 3 reinicios automáticos a 5 s, 15 s y 60 s" $failure
  Check ($failure -match "86400") "el contador de fallos se reinicia tras un día" $failure
  $flag = sc.exe qfailureflag $ServiceName | Out-String
  Check ($flag -match "TRUE|VERDADERO|YES|S[IÍ]\b|:\s*1\b") "la recuperación aplica también a salidas con error" $flag

  # 3. Permisos de la configuración (tiene secretos). Se comparan SID, no nombres traducidos.
  $sids = (Get-Acl $cfg).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
  $bad = $sids | Where-Object { $_ -in @("S-1-1-0", "S-1-5-11", "S-1-5-32-545") }  # Todos, Usuarios autenticados, Usuarios
  Check (-not $bad) "agent.yaml no es legible por usuarios comunes (Todos / Usuarios)" ($sids -join " ")
  Check ($sids -contains "S-1-5-19") "agent.yaml es legible por la cuenta del servicio (LocalService)" ($sids -join " ")
  Check (($sids | Where-Object { $_ -notin @("S-1-5-18", "S-1-5-32-544", "S-1-5-19") }).Count -eq 0) "solo SYSTEM, Administradores y LocalService tienen acceso" ($sids -join " ")

  # 4. Arrancar y comprobar que trabaja de verdad.
  & $agent service start -name $ServiceName
  Check ($LASTEXITCODE -eq 0) "service start deja el servicio en marcha"
  $pid1 = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").ProcessId
  Check ($pid1 -gt 0) "el servicio tiene proceso" $pid1
  $logged = Wait-Until { (Test-Path $log) -and ((Get-Content $log -Raw) -match "ciclo terminado") } 30
  Check $logged "escribe el log en archivo (ciclo terminado)" $log
  $since = Get-Date
  $beat = Wait-Until {
    $r = docker exec $DbContainer psql -U postgres -t -A -c "select last_heartbeat_at > now() - interval '20 seconds' from organizations where slug='$OrgSlug'"
    "$r".Trim() -eq "t"
  } 40
  Check $beat "el servicio llega a la API (latido reciente de $OrgSlug)"

  # 5. Caída: matar el proceso y comprobar que el SCM lo reinicia.
  Stop-Process -Id $pid1 -Force
  $restarted = Wait-Until {
    $s = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    ($s.State -eq "Running") -and ($s.ProcessId -gt 0) -and ($s.ProcessId -ne $pid1)
  } 45
  Check $restarted "tras matar el proceso, el SCM lo reinicia solo (PID nuevo)"

  # 6. Detener: parada limpia.
  & $agent service stop -name $ServiceName
  Check (($LASTEXITCODE -eq 0) -and ((Get-Service $ServiceName).Status -eq "Stopped")) "service stop lo detiene"
  Check ((Get-Content $log -Raw) -match "servicio detenido") "la parada fue limpia (el log lo dice)"
  $st = & $agent service status -name $ServiceName | Out-String
  Check ($st -match "stopped") "service status informa 'stopped'" $st

  # 7. Desinstalar.
  & $agent service uninstall -name $ServiceName
  Check (($LASTEXITCODE -eq 0) -and -not (ServiceExists)) "service uninstall elimina el servicio"
  Check (Test-Path $cfg) "desinstalar no borra la configuración ni los datos"
  $none = & $agent service status -name $ServiceName 2>&1
  Check ($LASTEXITCODE -ne 0) "status de un servicio inexistente falla con mensaje" ($none -join " ")
}
catch { Write-Host "FALLO  excepción: $_"; $failures++ }
finally {
  if (ServiceExists) { sc.exe stop $ServiceName | Out-Null; Start-Sleep 2; sc.exe delete $ServiceName | Out-Null }
  if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}
if ($failures -eq 0) { Write-Host "`nTODO OK"; exit 0 } else { Write-Host "`n$failures comprobación(es) fallaron"; exit 1 }
