# Registration only. Builder-owned metadata; no caller flags/environment inputs.
Set-PSDebug -Off
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Stop-InfraPulseBootstrap([string] $Code) { throw $Code }
function Assert-InfraPulsePath([string] $Path, [bool] $Directory, [bool] $Private) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $Directory) { Stop-InfraPulseBootstrap 'UNSAFE_PATH' }
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { Stop-InfraPulseBootstrap 'FOREIGN_OWNER' }
    # Directory bits 2/4 are CreateFiles/CreateDirectories, not write/append to
    # an existing selected child. Standard drive/ProgramData create-only grants
    # cannot replace that child without DeleteChild/Delete/DAC/owner rights.
    # Keep attribute mutation (including reparse-relevant metadata), ancestor
    # deletion/replacement and security takeover forbidden. File bits 2/4 remain
    # actual WriteData/AppendData and are forbidden on non-private native files.
    $write = [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if (-not $Directory) { $write = $write -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) {
            # Creator-only inherited grants apply to new children, not this ancestor.
            if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 -and -not $Private) { continue }
            if ($Private -or ($rule.FileSystemRights -band $write) -ne 0) { Stop-InfraPulseBootstrap 'UNSAFE_ACL' }
        }
    }
    if ($Private -and ($owner -notin @('S-1-5-18', 'S-1-5-32-544') -or ($Path.StartsWith('C:\ProgramData\InfraPulse Agent', [StringComparison]::OrdinalIgnoreCase) -and -not $acl.AreAccessRulesProtected))) { Stop-InfraPulseBootstrap 'UNSAFE_ACL' }
}
function New-InfraPulseAcl([bool] $Directory) {
    if ($Directory) { $acl = New-Object Security.AccessControl.DirectorySecurity } else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        if ($Directory) { $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') }
        else { $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow') }
        $acl.AddAccessRule($rule)
    }
    return $acl
}
function Assert-InfraPulseMarker {
    if (Test-Path -LiteralPath (Join-Path $script:Root 'decommission.requested')) { Stop-InfraPulseBootstrap 'DECOMMISSION_REQUESTED' }
    # Enumerating also catches dangling reparse entries that Test-Path can miss.
    if (Get-ChildItem -LiteralPath $script:Root -Force | Where-Object Name -eq 'decommission.requested') { Stop-InfraPulseBootstrap 'DECOMMISSION_REQUESTED' }
}
function Write-InfraPulseRegistration([string] $Value) {
    $path = Join-Path $script:Root ('marker-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $target = Join-Path $script:Root 'registration'
    $bytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($Value)
    if ($bytes.Length -gt 256) { Stop-InfraPulseBootstrap 'MARKER_INVALID' }
    $stream = $null
    try {
        $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, (New-InfraPulseAcl $false))
        $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true); $stream.Dispose(); $stream = $null
        if (Test-Path -LiteralPath $target) { Assert-InfraPulsePath $target $false $true; [IO.File]::Replace($path, $target, $null) }
        else { [IO.File]::Move($path, $target) }
    } finally { if ($stream) { $stream.Dispose() }; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } }
}
function Get-InfraPulseSsmPackage([string] $Target, [bool] $Helper = $false) {
    # Canonical URL only: no redirects, proxy, credentials, or caller URL.
    $url = $script:Canonical.SsmUrl; $hash = $script:Canonical.SsmSha256; $signer = $script:Canonical.SsmSigner; $certificate = $script:Canonical.SsmCertificateSha256
    if ($Helper) { $url = $script:Canonical.HelperUrl; $hash = $script:Canonical.HelperSha256; $signer = $script:Canonical.HelperSigner; $certificate = $script:Canonical.HelperCertificateSha256 }
    $uri = [uri] $url
    if ($uri.Scheme -ne 'https' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo -or $uri.Port -ne 443) { Stop-InfraPulseBootstrap 'ARTIFACT_INVALID' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Proxy = $null; $request.AllowAutoRedirect = $false; $request.Timeout = 15000; $request.ReadWriteTimeout = 15000
    $response = $null; $inputStream = $null; $outputStream = $null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = $request.GetResponse()
        if ([int] $response.StatusCode -ne 200 -or $response.ContentLength -gt 134217728) { Stop-InfraPulseBootstrap 'DOWNLOAD_FAILED' }
        $inputStream = $response.GetResponseStream()
        $outputStream = New-Object IO.FileStream($Target, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 65536, [IO.FileOptions]::None, (New-InfraPulseAcl $false))
        $buffer = New-Object byte[] 65536; $total = 0
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $count
            if ($total -gt 134217728 -or $watch.Elapsed.TotalSeconds -gt 180) { Stop-InfraPulseBootstrap 'DOWNLOAD_FAILED' }
            $outputStream.Write($buffer, 0, $count)
        }
        $outputStream.Flush($true); $outputStream.Dispose(); $outputStream = $null
    } finally { if ($outputStream) { $outputStream.Dispose() }; if ($inputStream) { $inputStream.Dispose() }; if ($response) { $response.Dispose() }; $request.Abort() }
    if ((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash) { Stop-InfraPulseBootstrap 'HASH_MISMATCH' }
    Assert-InfraPulseSignature $Target $signer $certificate
}
function Assert-InfraPulseSignature([string] $Path, [string] $Signer, [string] $CertificateSha256) {
    if ($Path -cne 'C:\Program Files\Amazon\SSM\amazon-ssm-agent.exe' -and $Path -cnotmatch '^C:\\ProgramData\\InfraPulse Agent\\bootstrap-[a-f0-9]{32}\\(?:ssm-package|ssm-setup-cli)\.exe$') { Stop-InfraPulseBootstrap 'ARTIFACT_INVALID' }
    # Constant transient OS PowerShell command, strictly closed local paths, no
    # activation or caller command; process deadline also bounds trust retrieval.
    $command = '$s=Get-AuthenticodeSignature -LiteralPath ''' + $Path + '''; if($s.Status -ne ''Valid'' -or -not $s.SignerCertificate){exit 1}; [Console]::Write($s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)+'':''+$s.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant())'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $actual = Invoke-InfraPulseNative 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' ('-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded) 30
    if (-not $actual.StartsWith(($Signer + ':'), [StringComparison]::Ordinal) -or ($CertificateSha256 -and $actual -cne ($Signer + ':' + $CertificateSha256))) { Stop-InfraPulseBootstrap 'SIGNER_MISMATCH' }
}
function Assert-InfraPulseRegistrationProtocol {
    if ($script:Canonical.SsmVersion -cne '3.3.5828.0' -or $script:Canonical.HelperVersion -cne ('sha256:' + $script:Canonical.HelperSha256) -or $script:Canonical.HelperUrl -cne 'https://amazon-ssm-ap-southeast-1.s3.ap-southeast-1.amazonaws.com/latest/windows_amd64/ssm-setup-cli.exe' -or $script:Canonical.HelperSha256 -cnotmatch '^[a-f0-9]{64}$') { Stop-InfraPulseBootstrap 'REGISTRATION_PROTOCOL_UNSUPPORTED' }
}
function Invoke-InfraPulseNative([string] $Executable, [string] $Arguments, [int] $Seconds) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable; $start.Arguments = $Arguments; $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.WorkingDirectory = 'C:\Windows\System32'
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR')) { $start.EnvironmentVariables.Remove($name) }
    $process = New-Object Diagnostics.Process; $process.StartInfo = $start
    $watch = [Diagnostics.Stopwatch]::StartNew(); $text = New-Object Text.StringBuilder
    try {
        if (-not $process.Start()) { Stop-InfraPulseBootstrap 'NATIVE_FAILED' }
        $outBuffer = New-Object char[] 4096; $errBuffer = New-Object char[] 4096
        $outTask = $process.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length)
        $errTask = $process.StandardError.ReadAsync($errBuffer, 0, $errBuffer.Length)
        while ($outTask -or $errTask -or -not $process.HasExited) {
            if ($watch.Elapsed.TotalSeconds -gt $Seconds -or $text.Length -gt 65536) { Stop-InfraPulseBootstrap 'NATIVE_LIMIT' }
            if ($outTask -and $outTask.IsCompleted) {
                $count = $outTask.GetAwaiter().GetResult(); $outTask = $null
                if ($count -gt 0) { [void] $text.Append($outBuffer, 0, $count); $outTask = $process.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length) }
            }
            if ($errTask -and $errTask.IsCompleted) {
                $count = $errTask.GetAwaiter().GetResult(); $errTask = $null
                if ($count -gt 0) { [void] $text.Append($errBuffer, 0, $count); $errTask = $process.StandardError.ReadAsync($errBuffer, 0, $errBuffer.Length) }
            }
            Start-Sleep -Milliseconds 25
        }
        if ($process.ExitCode -ne 0) { Stop-InfraPulseBootstrap 'NATIVE_FAILED' }
        return $text.ToString()
    } finally {
        if ($process.Id -and -not $process.HasExited) {
            $killInfo = New-Object Diagnostics.ProcessStartInfo
            $killInfo.FileName = 'C:\Windows\System32\taskkill.exe'; $killInfo.Arguments = '/PID ' + $process.Id + ' /T /F'; $killInfo.UseShellExecute = $false; $killInfo.CreateNoWindow = $true; $killInfo.RedirectStandardOutput = $true; $killInfo.RedirectStandardError = $true
            $kill = [Diagnostics.Process]::Start($killInfo)
            if (-not $kill.WaitForExit(10000)) { $kill.Kill() }; $kill.Dispose()
        }
        $text.Clear() | Out-Null; $process.Dispose()
    }
}
function Assert-InfraPulseVault {
    foreach ($path in @('C:\ProgramData\Amazon', 'C:\ProgramData\Amazon\SSM', 'C:\ProgramData\Amazon\SSM\InstanceData', 'C:\ProgramData\Amazon\SSM\InstanceData\Vault', 'C:\ProgramData\Amazon\SSM\InstanceData\Vault\Store')) { Assert-InfraPulsePath $path $true $false }
    foreach ($path in @('C:\ProgramData\Amazon\SSM\InstanceData\Vault\Manifest', 'C:\ProgramData\Amazon\SSM\InstanceData\Vault\Store\RegistrationKey')) {
        Assert-InfraPulsePath $path $false $true
        if ((Get-Item -LiteralPath $path).Length -lt 1) { Stop-InfraPulseBootstrap 'IDENTITY_UNAVAILABLE' }
    }
}
function Assert-InfraPulseInstalledVersion {
    foreach ($path in @('C:\Program Files', 'C:\Program Files\Amazon', 'C:\Program Files\Amazon\SSM')) { Assert-InfraPulsePath $path $true $false }
    $binary = 'C:\Program Files\Amazon\SSM\amazon-ssm-agent.exe'
    Assert-InfraPulsePath $binary $false $false
    # The release pins the installer certificate, not the installed binary's
    # distinct signing certificate. Preserve Valid + trusted subject + exact version.
    Assert-InfraPulseSignature $binary $script:Canonical.SsmSigner ''
    if ((Invoke-InfraPulseNative $binary '-version' 15).TrimEnd("`r", "`n") -cne 'SSM Agent version: 3.3.5828.0') { Stop-InfraPulseBootstrap 'PACKAGE_VERSION_MISMATCH' }
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='AmazonSSMAgent'" -OperationTimeoutSec 15
    if (-not $service -or $service.StartName -cne 'LocalSystem') { Stop-InfraPulseBootstrap 'SERVICE_IDENTITY_MISMATCH' }
}
function Assert-InfraPulseAbsent {
    foreach ($ancestor in @('C:\Program Files', 'C:\Program Files\Amazon', 'C:\ProgramData\Amazon')) {
        if (Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue) { Assert-InfraPulsePath $ancestor $true $false }
    }
    foreach ($path in @('C:\ProgramData\InfraPulse AWS', 'C:\ProgramData\Amazon\SSM', 'C:\Program Files\Amazon\SSM', 'C:\Program Files\Amazon\AmazonCloudWatchAgent', 'C:\ProgramData\Amazon\AmazonCloudWatchAgent')) {
        if (Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue) { Stop-InfraPulseBootstrap 'MANUAL_ADOPTION_REQUIRED' }
    }
    foreach ($name in @('AmazonSSMAgent', 'AmazonCloudWatchAgent')) {
        if ((Get-Service -Name $name -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $name))) { Stop-InfraPulseBootstrap 'MANUAL_ADOPTION_REQUIRED' }
    }
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path -LiteralPath $root) {
            foreach ($key in Get-ChildItem -LiteralPath $root) {
                $name = Get-ItemPropertyValue -LiteralPath $key.PSPath -Name DisplayName -ErrorAction SilentlyContinue
                if ($name -match '(?i)(Amazon.*SSM|Amazon.*CloudWatch)') { Stop-InfraPulseBootstrap 'MANUAL_ADOPTION_REQUIRED' }
            }
        }
    }
}
function Register-InfraPulseNode([string] $Package) {
    $helper = Join-Path $script:Temporary 'ssm-setup-cli.exe'
    Get-InfraPulseSsmPackage $helper $true
    Assert-InfraPulseMarker
    # AWS EXE quiet, never reboot; any nonzero result (including 3010) is manual.
    $null = Invoke-InfraPulseNative $Package '/quiet /norestart' 180
    Assert-InfraPulseInstalledVersion
    Assert-InfraPulseMarker
    # Bounded process-memory capture only, no native log/receipt persistence.
    $output = Invoke-InfraPulseNative $helper ('-register -activation-id "' + $script:ActivationId + '" -activation-code "' + $script:ActivationCode + '" -region "' + $script:Region + '"') 240
    $script:ActivationCode = $null
    $registrationMatches = [regex]::Matches($output, '(?m)^.*Successfully registered the instance with AWS SSM using Managed instance-id: (mi-[0-9a-f]{17})\r?$')
    $output = $null
    if ($registrationMatches.Count -ne 1) { Stop-InfraPulseBootstrap 'REGISTRATION_UNCERTAIN' }
    Assert-InfraPulseVault; Assert-InfraPulseInstalledVersion
    return $registrationMatches[0].Groups[1].Value
}
function Invoke-InfraPulseBootstrap {
    if ($args.Count -ne 0) { Stop-InfraPulseBootstrap 'ARGUMENTS_REJECTED' }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Stop-InfraPulseBootstrap 'ADMIN_REQUIRED' }
    foreach ($name in @('Initialize-InfraPulseCanonical', 'Initialize-InfraPulseIntent')) {
        if (-not (Get-Command -Name $name -CommandType Function -ErrorAction SilentlyContinue)) { Stop-InfraPulseBootstrap 'CANONICAL_ASSET_REQUIRED' }
    }
    Initialize-InfraPulseCanonical
    Assert-InfraPulseRegistrationProtocol
    if (-not $PSCommandPath) { Stop-InfraPulseBootstrap 'PRIVATE_ATTACHMENT_REQUIRED' }
    Assert-InfraPulsePath $PSCommandPath $false $true
    $parent = [IO.Path]::GetDirectoryName($PSCommandPath)
    while ($parent) {
        Assert-InfraPulsePath $parent $true $false
        $next = [IO.Directory]::GetParent($parent)
        if (-not $next) { break }; $parent = $next.FullName
    }
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -OperationTimeoutSec 15
    if (-not [Environment]::Is64BitProcess -or $os.OSArchitecture -ne '64-bit' -or $os.BuildNumber -ne '20348' -or $os.ProductType -eq 1 -or $os.OSLanguage -ne 1033) { Stop-InfraPulseBootstrap 'UNSUPPORTED_PLATFORM' }
    if ((Get-Service -Name W32Time).Status -ne 'Running') { Stop-InfraPulseBootstrap 'CLOCK_NOT_READY' }
    $clock = Invoke-InfraPulseNative 'C:\Windows\System32\w32tm.exe' '/query /status' 15
    if ($clock -notmatch '(?m)^Leap Indicator:\s*0\b' -or $clock -match '(?m)^Source:\s*(Local CMOS Clock|Free-running System Clock)\s*$') { Stop-InfraPulseBootstrap 'CLOCK_NOT_READY' }
    $clock = $null
    $script:Root = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'InfraPulse Agent'
    if ($script:Root -cne 'C:\ProgramData\InfraPulse Agent') { Stop-InfraPulseBootstrap 'UNSUPPORTED_PLATFORM' }
    Assert-InfraPulsePath 'C:\' $true $false
    Assert-InfraPulsePath 'C:\ProgramData' $true $false
    if (-not (Test-Path -LiteralPath $script:Root)) { [IO.Directory]::CreateDirectory($script:Root, (New-InfraPulseAcl $true)) | Out-Null }
    Assert-InfraPulsePath $script:Root $true $true
    $lockPath = Join-Path $script:Root 'lock'
    $lock = $null; $temporary = $null
    try {
        # Enumerate first so dangling reparse entries cannot be OpenOrCreate targets.
        foreach ($entry in Get-ChildItem -LiteralPath $script:Root -Force) {
            if ($entry.Name -in @('lock', 'registration')) { Assert-InfraPulsePath $entry.FullName $false $true }
        }
        $lock = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, (New-InfraPulseAcl $false))
        Assert-InfraPulsePath $lockPath $false $true
        Assert-InfraPulseMarker
        Initialize-InfraPulseIntent
        $uuid = '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        if ($script:ServerId -cnotmatch $uuid -or $script:EnrollmentId -cnotmatch $uuid -or $script:ActivationId -cnotmatch $uuid -or $script:Generation -cnotmatch '^[1-9][0-9]{0,9}$' -or $script:Region -cne 'ap-southeast-1' -or $script:PresetHash -cne $script:Canonical.PresetHash -or $script:Canonical.ConfigurationVersion -cnotmatch '^[a-f0-9]{64}$' -or $script:ActivationCode -cnotmatch '^[A-Za-z0-9+/=_-]{1,250}$') { Stop-InfraPulseBootstrap 'INTENT_INVALID' }
        $registrationPath = Join-Path $script:Root 'registration'
        if (Test-Path -LiteralPath $registrationPath) {
            Assert-InfraPulsePath $registrationPath $false $true
            if ((Get-Item -LiteralPath $registrationPath).Length -gt 256) { Stop-InfraPulseBootstrap 'MARKER_INVALID' }
            $owner = [IO.File]::ReadAllText($registrationPath); $parts = $owner -split ':'
            if ($parts.Count -ne 4) { Stop-InfraPulseBootstrap 'MARKER_INVALID' }
            $node = $parts[2]
            if ($owner -cne ($script:ServerId + ':' + $script:EnrollmentId + ':' + $node + ':' + $script:Canonical.ConfigurationVersion) -or $node -cnotmatch '^mi-[0-9a-f]{17}$') { Stop-InfraPulseBootstrap 'REGISTRATION_UNCERTAIN' }
            Assert-InfraPulseVault; Assert-InfraPulseInstalledVersion
            $script:ActivationCode = $null
            Write-Output 'ALREADY_REGISTERED'; return
        }
        if (Get-ChildItem -LiteralPath $script:Root -Force | Where-Object Name -ne 'lock') { Stop-InfraPulseBootstrap 'MANUAL_ADOPTION_REQUIRED' }
        Assert-InfraPulseAbsent
        # Durable pending ownership BEFORE I/O: failures cannot replay activation.
        # Separate SSM registration from the document's CloudWatch owner marker.
        Write-InfraPulseRegistration ($script:ServerId + ':' + $script:EnrollmentId + ':pending:' + $script:Canonical.ConfigurationVersion)
        Assert-InfraPulseMarker
        $temporary = Join-Path $script:Root ('bootstrap-' + [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($temporary, (New-InfraPulseAcl $true)) | Out-Null
        $script:Temporary = $temporary
        $package = Join-Path $temporary 'ssm-package.exe'
        Get-InfraPulseSsmPackage $package
        Assert-InfraPulseMarker
        $node = Register-InfraPulseNode $package
        if ($node -cnotmatch '^mi-[0-9a-f]{17}$') { Stop-InfraPulseBootstrap 'REGISTRATION_UNCERTAIN' }
        Assert-InfraPulseMarker
        Write-InfraPulseRegistration ($script:ServerId + ':' + $script:EnrollmentId + ':' + $node + ':' + $script:Canonical.ConfigurationVersion)
        Write-Output 'REGISTERED'
    } finally {
        $script:ActivationCode = $null
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Assert-InfraPulsePath $temporary $true $true; Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
        if ($lock) { $lock.Dispose() }
    }
}
try { Invoke-InfraPulseBootstrap @args } catch { [Console]::Error.WriteLine('BOOTSTRAP_FAILED_MANUAL_REVIEW'); exit 1 }
