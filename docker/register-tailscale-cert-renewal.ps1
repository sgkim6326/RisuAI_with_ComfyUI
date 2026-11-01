$ErrorActionPreference = 'Stop'

$taskName = 'RisuAI Tailscale HTTPS Certificate Renewal'
$renewalScript = Join-Path $PSScriptRoot 'renew-tailscale-cert.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute $powershell `
    -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$renewalScript`""
$triggers = @(
    (New-ScheduledTaskTrigger -Daily -At '3:30AM'),
    (New-ScheduledTaskTrigger -AtLogOn -User $identity)
)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Description 'Renews and safely reloads the Tailscale HTTPS certificate used by the RisuAI Nginx proxy.' `
    -Action $action `
    -Trigger $triggers `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
