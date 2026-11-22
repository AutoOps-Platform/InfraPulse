# Practical Windows hybrid SSM registration script (Windows x64).
Set-PSDebug -Off
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Stop-InfraPulseBootstrap([string] $Code) { throw $Code }

function Write-InfraPulseRegistration([string] $Value) {
    $target = Join-Path $script:Root 'registration'
    $tmp = Join-Path $script:Root ('marker-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($tmp, $Value, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tmp -Destination $target -Force
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

function Get-InfraPulseArtifact([string] $Url, [string] $Target, [string] $ExpectedHash) {
    if ($Url -notmatch '^https://') { Stop-InfraPulseBootstrap 'ARTIFACT_INVALID' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Target -TimeoutSec 180
    $actual = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $ExpectedHash) { Stop-InfraPulseBootstrap 'HASH_MISMATCH' }
}

function Invoke-InfraPulseProcess([string] $FilePath, [string] $Arguments, [int] $TimeoutSeconds) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = New-Object Diagnostics.Process
    $proc.StartInfo = $psi
    try {
        if (-not $proc.Start()) { Stop-InfraPulseBootstrap 'NATIVE_FAILED' }
        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderrTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill() } catch {}
            Stop-InfraPulseBootstrap 'NATIVE_TIMEOUT'
        }
        $out = $stdoutTask.GetAwaiter().GetResult()
        $err = $stderrTask.GetAwaiter().GetResult()
        return @{ ExitCode = $proc.ExitCode; Output = ($out + "`n" + $err) }
    } finally {
        $proc.Dispose()
    }
}

function Invoke-InfraPulseBootstrap {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Stop-InfraPulseBootstrap 'ADMIN_REQUIRED' }
    if (-not [Environment]::Is64BitOperatingSystem) { Stop-InfraPulseBootstrap 'UNSUPPORTED_PLATFORM' }
    foreach ($name in @('Initialize-InfraPulseCanonical', 'Initialize-InfraPulseIntent')) {
        if (-not (Get-Command -Name $name -CommandType Function -ErrorAction SilentlyContinue)) { Stop-InfraPulseBootstrap 'CANONICAL_ASSET_REQUIRED' }
    }

    Initialize-InfraPulseCanonical
    Initialize-InfraPulseIntent

    $script:Root = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'InfraPulse Agent'
    if (-not (Test-Path -LiteralPath $script:Root)) { New-Item -ItemType Directory -Path $script:Root -Force | Out-Null }
    if (Test-Path -LiteralPath (Join-Path $script:Root 'decommission.requested')) { Stop-InfraPulseBootstrap 'DECOMMISSION_REQUESTED' }

    $registrationPath = Join-Path $script:Root 'registration'
    if (Test-Path -LiteralPath $registrationPath) {
        $owner = ([IO.File]::ReadAllText($registrationPath)).Trim()
        $parts = $owner -split ':'
        if ($parts.Count -eq 4 -and $parts[2] -cmatch '^mi-[0-9a-f]{17}$' -and $owner -ceq ($script:ServerId + ':' + $script:EnrollmentId + ':' + $parts[2] + ':' + $script:Canonical.ConfigurationVersion)) {
            $script:ActivationCode = $null
            Start-Service -Name AmazonSSMAgent -ErrorAction SilentlyContinue
            Write-Output 'ALREADY_REGISTERED'
            return
        }
    }

    Write-InfraPulseRegistration ($script:ServerId + ':' + $script:EnrollmentId + ':pending:' + $script:Canonical.ConfigurationVersion)
    $temporary = Join-Path $script:Root ('bootstrap-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary -Force | Out-Null
    try {
        $package = Join-Path $temporary 'AmazonSSMAgentSetup.exe'
        $helper = Join-Path $temporary 'ssm-setup-cli.exe'
        Get-InfraPulseArtifact $script:Canonical.SsmUrl $package $script:Canonical.SsmSha256
        Get-InfraPulseArtifact $script:Canonical.HelperUrl $helper $script:Canonical.HelperSha256

        Stop-Service -Name AmazonSSMAgent -Force -ErrorAction SilentlyContinue
        $install = Invoke-InfraPulseProcess $package '/quiet /norestart' 180
        if ($install.ExitCode -ne 0 -and $install.ExitCode -ne 3010) { Stop-InfraPulseBootstrap ('SSM_INSTALL_FAILED_' + $install.ExitCode) }

        $regArgs = '-register -activation-id "' + $script:ActivationId + '" -activation-code "' + $script:ActivationCode + '" -region "' + $script:Region + '"'
        $reg = Invoke-InfraPulseProcess $helper $regArgs 240
        $script:ActivationCode = $null
        if ($reg.ExitCode -ne 0) { Stop-InfraPulseBootstrap 'REGISTRATION_FAILED' }

        $m = [regex]::Match($reg.Output, 'Managed instance-id:\s*(mi-[0-9a-f]{17})')
        if (-not $m.Success) { Stop-InfraPulseBootstrap 'REGISTRATION_UNCERTAIN' }
        $node = $m.Groups[1].Value

        Set-Service -Name AmazonSSMAgent -StartupType Automatic -ErrorAction SilentlyContinue
        Start-Service -Name AmazonSSMAgent -ErrorAction SilentlyContinue
        Write-InfraPulseRegistration ($script:ServerId + ':' + $script:EnrollmentId + ':' + $node + ':' + $script:Canonical.ConfigurationVersion)
        Write-Output 'REGISTERED'
    } finally {
        $script:ActivationCode = $null
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Invoke-InfraPulseBootstrap
} catch {
    [Console]::Error.WriteLine(('BOOTSTRAP_FAILED: ' + $_.Exception.Message))
    exit 1
}
