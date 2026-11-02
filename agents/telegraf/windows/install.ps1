#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$ManagementUrl,
    [string]$GatewayOrigin,
    [string]$KeyFile,
    [string]$TelegrafBinary,
    [string]$TelegrafSha256,
    [string]$ManagementCa,
    [string]$GatewayCa,
    [string]$PythonExecutable,
    [switch]$UpdateConfig,
    [switch]$PromptKey
)
$ErrorActionPreference = 'Stop'
try {
    Import-Module (Join-Path $PSScriptRoot 'AgentLifecycle.psm1') -Force
    Invoke-AgentInstall @PSBoundParameters -BundleRoot (Split-Path -Parent $PSScriptRoot)
} catch {
    # Only finite local lifecycle errors are surfaced; native/HTTP error objects
    # must not leak secrets, request headers, remote bodies or stack traces.
    $code = [string]$_.Exception.Message
    if ($code -match '^[a-z0-9_]+(?:; [a-zA-Z0-9_ /,.-]+)?$') { Write-Host ('agent_error: ' + $code) }
    else { Write-Host 'agent_error: windows_installation_failed; check privileges, protected files and service ownership' }
    exit 1
}
