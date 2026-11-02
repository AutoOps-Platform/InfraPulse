Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ServiceName = 'infrapulse-telegraf'
$script:Root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'InfraPulse Agent'
$script:Marker = 'InfraPulse.Telegraf.Installer.v1'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'administrator_required'
    }
}

function Assert-SafePath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $existing = $full
    while (-not (Test-Path -LiteralPath $existing)) {
        $parent = Split-Path -Parent $existing
        if (-not $parent -or $parent -eq $existing) { throw 'invalid_absolute_path' }
        $existing = $parent
    }
    $item = Get-Item -LiteralPath $existing -Force
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe_reparse_point' }
        $parent = Split-Path -Parent $item.FullName
        if (-not $parent -or $parent -eq $item.FullName) { break }
        $item = Get-Item -LiteralPath $parent -Force
    }
    return $full
}

function Set-PrivateAcl([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = [Security.Principal.SecurityIdentifier]::new($sid)
        if ($item.PSIsContainer) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        } else {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
        }
        [void]$acl.AddAccessRule($rule)
    }
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-OwnedTree([string]$Path) {
    [void](Assert-SafePath $Path)
    $items = @((Get-Item -LiteralPath $Path -Force)) + @(Get-ChildItem -LiteralPath $Path -Force -Recurse)
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($item in $items) {
        [void](Assert-SafePath $item.FullName)
        $acl = Get-Acl -LiteralPath $item.FullName
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @('S-1-5-18', 'S-1-5-32-544', $currentUser)) { throw 'unsafe_installation_owner' }
        foreach ($entry in $acl.Access) {
            if ($entry.AccessControlType -ne 'Allow') { continue }
            $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($sid -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'unsafe_installation_permissions' }
        }
    }
}

function Assert-PrivateKey([string]$Path) {
    $full = Assert-SafePath $Path
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer -or $item.Length -gt 512) { throw 'invalid_key_file' }
    $acl = Get-Acl -LiteralPath $full
    foreach ($entry in $acl.Access) {
        if ($entry.AccessControlType -ne 'Allow') { continue }
        $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if ($sid -notin @('S-1-5-18','S-1-5-32-544',$user)) { throw 'key_file_permissions_too_broad' }
    }
    return $full
}

function ConvertTo-NativeArgument([string]$Value) {
    # Windows CRT quoting, independent of Windows PowerShell 5.1's legacy native
    # marshalling. In particular preserve embedded quotes in SCM's binPath value.
    if ($Value.IndexOf([char]0) -ge 0) { throw 'invalid_native_argument' }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (2 * $slashes + 1)))
        } else { [void]$builder.Append(('\' * $slashes)) }
        [void]$builder.Append($character)
        $slashes = 0
    }
    [void]$builder.Append(('\' * (2 * $slashes)))
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-SafeNative([string]$Program, [string[]]$Arguments, [string]$Code) {
    # Child messages may contain remote bodies/config: drain to null, never relay.
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Program
    $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw $Code }
        $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        if (-not $process.WaitForExit(180000)) { $process.Kill(); throw $Code }
        $stdout.GetAwaiter().GetResult()
        $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw $Code }
    } finally { $process.Dispose() }
}

function Get-OwnedInstallation {
    Assert-OwnedTree $script:Root
    $marker = Join-Path $script:Root 'owner.txt'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        [IO.File]::ReadAllText($marker).Trim() -ne $script:Marker) { throw 'unrecognized_installation_directory' }
    [void](Assert-SafePath $marker)
    $active = Join-Path $script:Root 'active.json'
    if (-not (Test-Path -LiteralPath $active)) { return $null }
    [void](Assert-SafePath $active)
    $record = [IO.File]::ReadAllText($active) | ConvertFrom-Json
    if ($record.release -notmatch '^[0-9a-f]{32}$') { throw 'invalid_installation_state' }
    $release = Join-Path (Join-Path $script:Root 'releases') $record.release
    [void](Assert-SafePath $release)
    if (-not (Test-Path -LiteralPath (Join-Path $release 'state.json'))) { throw 'invalid_installation_state' }
    return $release
}

function Get-OwnedService([string]$Release) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$script:ServiceName'"
    if ($null -eq $service) { return $null }
    if (-not $Release -or $service.PathName -ne (Get-ServiceCommand $Release) -or
        $service.StartName -notin @('LocalSystem','NT AUTHORITY\\SYSTEM')) { throw 'foreign_service_refused' }
    return $service
}

function Get-ServiceCommand([string]$Release) {
    return ('"{0}" --config "{1}" --config-directory "{2}" --service-name {3}' -f
        (Join-Path $Release 'telegraf.exe'), (Join-Path $Release 'telegraf.conf'),
        (Join-Path $Release 'conf.d'), $script:ServiceName)
}

function Stop-OwnedService {
    $service = Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $service -and $service.Status -ne 'Stopped') {
        Stop-Service -Name $script:ServiceName -ErrorAction Stop
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
}

function Remove-OwnedRelease([string]$Release) {
    $full = Assert-SafePath $Release
    $parent = [IO.Path]::GetFullPath((Join-Path $script:Root 'releases'))
    if ((Split-Path -Parent $full) -ne $parent -or (Split-Path -Leaf $full) -notmatch '^[0-9a-f]{32}$') {
        throw 'unsafe_cleanup_path'
    }
    # Validate every descendant BEFORE recursive deletion (including junctions).
    foreach ($item in Get-ChildItem -LiteralPath $full -Force -Recurse) { [void](Assert-SafePath $item.FullName) }
    Remove-Item -LiteralPath $full -Recurse -Force
}

function Set-ActiveRelease([string]$Release) {
    $temp = Join-Path $script:Root ('active-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temp, (@{release=(Split-Path -Leaf $Release)} | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Set-PrivateAcl $temp
    $target = Join-Path $script:Root 'active.json'
    if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temp, $target, $null) }
    else { [IO.File]::Move($temp, $target) }
}

function Invoke-AgentInstall {
    param([string]$ManagementUrl, [string]$GatewayOrigin, [string]$KeyFile,
          [string]$TelegrafBinary, [string]$TelegrafSha256, [string]$ManagementCa,
          [string]$GatewayCa, [string]$PythonExecutable, [switch]$UpdateConfig,
          [switch]$PromptKey, [string]$BundleRoot)
    Assert-Administrator
    [void](Assert-SafePath $script:Root)
    if (-not (Test-Path -LiteralPath $script:Root)) {
        [void](New-Item -ItemType Directory -Path $script:Root)
        Set-PrivateAcl $script:Root
        [IO.File]::WriteAllText((Join-Path $script:Root 'owner.txt'), $script:Marker)
    }
    $previous = Get-OwnedInstallation
    Set-PrivateAcl $script:Root
    $lock = [IO.File]::Open((Join-Path $script:Root 'installer.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $candidate = $null; $mutated = $false; $activated = $false; $serviceInstallAttempted = $false
    $oldService = $null; $stage = 'prepare'
    try {
        # Re-read under lock; no assumptions from before single-writer admission.
        $previous = Get-OwnedInstallation
        $oldService = Get-OwnedService $previous
        $eventSource = 'HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\' + $script:ServiceName
        if (-not $oldService -and (Test-Path -LiteralPath $eventSource)) { throw 'foreign_eventlog_source_refused' }
        $bindingPath = Join-Path $script:Root 'binding.json'
        $previousState = if ($previous) { [IO.File]::ReadAllText((Join-Path $previous 'state.json')) | ConvertFrom-Json } else { $null }
        if (Test-Path -LiteralPath $bindingPath) { [void](Assert-SafePath $bindingPath) }
        $priorBinding = if ($previous) { Join-Path $previous 'state.json' } elseif (Test-Path -LiteralPath $bindingPath) { $bindingPath } else { $null }
        if ($previousState) {
            if (-not $ManagementUrl) { $ManagementUrl = $previousState.management_url }
            if (-not $GatewayOrigin) { $GatewayOrigin = $previousState.gateway_origin }
            if (-not $ManagementCa) { $ManagementCa = $previousState.management_ca }
            if (-not $GatewayCa) { $GatewayCa = $previousState.gateway_ca }
            if (-not $KeyFile -and -not $PromptKey) { $KeyFile = Join-Path $previous 'api-key' }
        }
        if (-not $ManagementUrl -or -not $GatewayOrigin) { throw 'https_origins_required' }
        if ($UpdateConfig) {
            if (-not $previous -or $TelegrafBinary -or $TelegrafSha256) { throw 'invalid_update_config_arguments' }
            $metadata = [IO.File]::ReadAllText((Join-Path $previous 'install.json')) | ConvertFrom-Json
            $TelegrafBinary = Join-Path $previous 'telegraf.exe'
            $TelegrafSha256 = $metadata.telegraf_sha256
        }
        if (-not $TelegrafBinary -or $TelegrafSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'binary_and_sha256_required' }
        $TelegrafBinary = Assert-SafePath $TelegrafBinary
        if ((Get-FileHash -LiteralPath $TelegrafBinary -Algorithm SHA256).Hash -ne $TelegrafSha256) { throw 'binary_sha256_mismatch' }
        if (-not $PythonExecutable) { $PythonExecutable = (Get-Command python.exe -CommandType Application -ErrorAction Stop).Source }
        $PythonExecutable = Assert-SafePath $PythonExecutable
        if (-not [IO.Path]::IsPathRooted($PythonExecutable)) { throw 'python_absolute_path_required' }
        $releases = Join-Path $script:Root 'releases'
        if (-not (Test-Path -LiteralPath $releases)) { [void](New-Item -ItemType Directory -Path $releases) }
        [void](Assert-SafePath $releases)
        $candidate = Join-Path $releases ([guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Path $candidate)
        Set-PrivateAcl $candidate
        $stagingKey = Join-Path $script:Root ('key-' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            if ($PromptKey) {
                if ($KeyFile) { throw 'choose_key_file_or_prompt' }
                $secure = Read-Host 'Agent API Key (hidden)' -AsSecureString
                $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
                try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr); [IO.File]::WriteAllText($stagingKey, $plain, [Text.UTF8Encoding]::new($false)) }
                finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $plain = $null; $secure.Dispose() }
            } else {
                if (-not $KeyFile) { throw 'key_file_or_prompt_required' }
                $KeyFile = Assert-PrivateKey $KeyFile
                Copy-Item -LiteralPath $KeyFile -Destination $stagingKey
            }
            Set-PrivateAcl $stagingKey
            $arguments = @('-I', (Join-Path $BundleRoot 'common\agentctl.py'), 'prepare', '--os', 'windows',
                '--management-url', $ManagementUrl, '--gateway-origin', $GatewayOrigin, '--key-file', $stagingKey,
                '--destination', $candidate, '--runtime-dir', $candidate)
            if ($ManagementCa) { $arguments += @('--management-ca', (Assert-SafePath $ManagementCa)) }
            if ($GatewayCa) { $arguments += @('--gateway-ca', (Assert-SafePath $GatewayCa)) }
            if ($priorBinding) { $arguments += @('--previous-state', $priorBinding) }
            Invoke-SafeNative $PythonExecutable $arguments 'provisioning_or_render_failed'
        } finally {
            if (Test-Path -LiteralPath $stagingKey) { Remove-Item -LiteralPath $stagingKey -Force }
        }
        # Keep an immutable local identity binding even if first activation fails.
        if (-not (Test-Path -LiteralPath $bindingPath)) {
            $newState = [IO.File]::ReadAllText((Join-Path $candidate 'state.json')) | ConvertFrom-Json
            $binding = @{schema_version=1; os=$newState.os; server_id=$newState.server_id;
                agent_id=$newState.agent_id; management_url=$newState.management_url}
            [IO.File]::WriteAllText($bindingPath, ($binding | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
            Set-PrivateAcl $bindingPath
        }
        Copy-Item -LiteralPath $TelegrafBinary -Destination (Join-Path $candidate 'telegraf.exe')
        # Verify the installed copy too, eliminating source replacement between hash/copy.
        if ((Get-FileHash -LiteralPath (Join-Path $candidate 'telegraf.exe') -Algorithm SHA256).Hash -ne $TelegrafSha256) { throw 'copied_binary_sha256_mismatch' }
        [IO.File]::WriteAllText((Join-Path $candidate 'install.json'), (@{telegraf_sha256=$TelegrafSha256.ToLowerInvariant()} | ConvertTo-Json -Compress))
        $bundle = Join-Path $candidate 'bundle'
        [void](New-Item -ItemType Directory -Path $bundle)
        foreach ($name in @('common','templates','windows')) {
            $source = Assert-SafePath (Join-Path $BundleRoot $name)
            foreach ($item in Get-ChildItem -LiteralPath $source -Force -Recurse) { [void](Assert-SafePath $item.FullName) }
            Copy-Item -LiteralPath $source -Destination $bundle -Recurse
        }
        Set-PrivateAcl $candidate
        foreach ($item in Get-ChildItem -LiteralPath $candidate -Force -Recurse) { Set-PrivateAcl $item.FullName }
        Assert-OwnedTree $candidate
        $stage = 'activate'; $mutated = $true
        Stop-OwnedService
        if ($oldService) {
            Invoke-SafeNative "$env:SystemRoot\System32\sc.exe" @('config', $script:ServiceName, 'binPath=', (Get-ServiceCommand $candidate), 'start=', 'auto') 'service_configuration_failed'
        } else {
            # Native install may create SCM state then fail or time out; cleanup
            # must inspect that partial state, not depend on a successful exit.
            $serviceInstallAttempted = $true
            Invoke-SafeNative (Join-Path $candidate 'telegraf.exe') @('--service', 'install', '--service-name', $script:ServiceName,
                '--service-display-name', 'InfraPulse Telegraf Agent', '--config', (Join-Path $candidate 'telegraf.conf'),
                '--config-directory', (Join-Path $candidate 'conf.d')) 'service_install_failed'
        }
        Invoke-SafeNative "$env:SystemRoot\System32\sc.exe" @('failure', $script:ServiceName, 'reset=', '86400', 'actions=', 'restart/10000/restart/30000/restart/60000') 'service_recovery_configuration_failed'
        Start-Service -Name $script:ServiceName
        (Get-Service -Name $script:ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
        Set-ActiveRelease $candidate
        $activated = $true
        Write-Host 'agent_local_activation_accepted (not ingestion/Online verification)'
        try {
            Invoke-SafeNative $PythonExecutable @('-I', (Join-Path $candidate 'bundle\common\agentctl.py'), 'report', '--state',
                (Join-Path $candidate 'state.json'), '--key-file', (Join-Path $candidate 'api-key'), '--result', 'applied') 'config_report_pending'
        } catch { Write-Warning 'agent_local_activation_accepted_but_config_report_pending; retry from protected installed bundle' }
        if ($previous) {
            try {
                if ($previousState.report_pending -eq $false) { Remove-OwnedRelease $previous }
                else { Write-Warning 'previous_report_pending; protected receipt and credential retained for explicit administration' }
            } catch { Write-Warning 'old_release_cleanup_pending; retained files include credential, remove with owned uninstaller' }
        }
    } catch {
        $failureCode = [string]$_.Exception.Message
        if ($failureCode -notmatch '^[a-z0-9_]+$') { $failureCode = 'local_operation_failed' }
        if (-not $activated -and $mutated) {
            try {
                if (-not $oldService -and $serviceInstallAttempted) { [void](Get-OwnedService $candidate) }
                Stop-OwnedService
                if ($oldService) {
                    Invoke-SafeNative "$env:SystemRoot\System32\sc.exe" @('config', $script:ServiceName, 'binPath=', $oldService.PathName,
                        'start=', $(if ($oldService.StartMode -eq 'Auto') {'auto'} elseif ($oldService.StartMode -eq 'Disabled') {'disabled'} else {'demand'})) 'rollback_service_failed'
                    if ($oldService.State -eq 'Running') { Start-Service -Name $script:ServiceName }
                } elseif ($serviceInstallAttempted) {
                    Invoke-SafeNative (Join-Path $candidate 'telegraf.exe') @('--service', 'uninstall', '--service-name', $script:ServiceName) 'rollback_service_remove_failed'
                }
            } catch { Write-Warning 'rollback_incomplete; service may reference candidate; no automatic cleanup' ; $candidate = $null }
        }
        if (-not $activated -and $candidate) {
            if (Test-Path -LiteralPath (Join-Path $candidate 'state.json')) {
                try { Invoke-SafeNative $PythonExecutable @('-I', (Join-Path $BundleRoot 'common\agentctl.py'), 'report', '--state',
                    (Join-Path $candidate 'state.json'), '--key-file', (Join-Path $candidate 'api-key'), '--result', 'failed') 'failed_report_pending' }
                catch { Write-Warning 'failed_config_report_not_delivered' }
            }
            try { Remove-OwnedRelease $candidate } catch { Write-Warning 'candidate_cleanup_pending' }
        }
        throw ('agent_install_failed_at_' + $stage + '; ' + $failureCode + ', review private local state and prerequisites')
    } finally { $lock.Dispose() }
}

function Invoke-AgentUninstall {
    Assert-Administrator
    [void](Assert-SafePath $script:Root)
    if (-not (Test-Path -LiteralPath $script:Root)) {
        if (Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue) { throw 'foreign_service_refused' }
        Write-Host 'agent_not_installed'; return
    }
    $release = Get-OwnedInstallation
    $lock = [IO.File]::Open((Join-Path $script:Root 'installer.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try {
        $release = Get-OwnedInstallation
        $service = Get-OwnedService $release
        if ($service) {
            Stop-OwnedService
            Invoke-SafeNative (Join-Path $release 'telegraf.exe') @('--service', 'uninstall', '--service-name', $script:ServiceName) 'service_uninstall_failed'
        }
        # Check full tree before removal. No remote revoke; Admin retains authority.
        foreach ($item in Get-ChildItem -LiteralPath $script:Root -Force -Recurse) { [void](Assert-SafePath $item.FullName) }
        foreach ($item in Get-ChildItem -LiteralPath $script:Root -Force) {
            if ($item.Name -in @('installer.lock', 'owner.txt')) { continue }
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
    } finally { $lock.Dispose() }
    # Keep empty owned root + lock to avoid lock-file replacement races between
    # parallel install/uninstall processes. No credential/config/binary remains.
    Write-Host 'agent_removed; revoke API credential through Management Admin API separately'
}

Export-ModuleMember -Function Invoke-AgentInstall,Invoke-AgentUninstall
