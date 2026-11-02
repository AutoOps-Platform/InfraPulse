#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
try {
    Import-Module (Join-Path $PSScriptRoot 'AgentLifecycle.psm1') -Force
    Invoke-AgentUninstall
} catch {
    Write-Host 'agent_error: windows_uninstall_failed; check owned service and reparse-free installation tree'
    exit 1
}
