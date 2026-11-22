{
  "linux": {
    "preamble": [
      "#!/bin/bash",
      "set +x; set +v; set -euo pipefail; umask 077",
      "export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C",
      "root=/var/lib/infrapulse-agent; cw=/opt/aws/amazon-cloudwatch-agent; action=@@ACTION@@; code=CONFIGURE_FAILED; version=null; service=null; resources='[]'; owns=false",
      "summary() { local result=$?; trap - EXIT; if [[ ${#resources} -gt 12000 ]]; then resources='[]'; code=SUMMARY_TOO_LARGE; result=1; fi; if [[ $action != prepare || $result != 0 ]]; then jq -cn --arg server '{{ ServerId }}' --arg enrollment '{{ EnrollmentId }}' --arg node '{{ ManagedNodeId }}' --arg operation '{{ OperationId }}' --arg config '{{ ConfigurationVersion }}' --arg step \"$action\" --arg error \"$code\" --argjson result \"$result\" --argjson version \"$version\" --argjson service \"$service\" --argjson resources \"$resources\" '{serverId:$server,enrollmentId:$enrollment,nodeId:$node,operationId:$operation,platform:\"linux\",configurationVersion:$config,step:$step,errorCode:(if $result==0 then null else $error end),cloudWatchVersion:$version,serviceState:$service,resources:$resources}' || printf '%s\\n' '{\"step\":\"prepare\",\"errorCode\":\"DEPENDENCY_UNAVAILABLE\",\"cloudWatchVersion\":null,\"serviceState\":null,\"resources\":[]}'; fi; if $owns && [[ $action != prepare || $result != 0 ]]; then rm -f -- \"$root/active\"; fi; exit \"$result\"; }; trap summary EXIT",
      "[[ $(id -u) == 0 && '{{ Platform }}' == linux ]]",
      "if ! command -v jq >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null 2>&1 || true; fi",
      "for tool in jq flock findmnt timeout sha256sum systemctl; do command -v \"$tool\" >/dev/null; done",
      "mkdir -p -m 0700 -- \"$root\"",
      "exec 9>\"$root/lock\"; code=CONFLICT; flock -w 30 9",
      "owner='{{ ServerId }}:{{ EnrollmentId }}:{{ ManagedNodeId }}'",
      "printf '%s' \"$owner\" > \"$root/owner\"",
      "printf '%s' '{{ OperationId }}' > \"$root/active\"; owns=true",
      "release=$(printf '%s' '@@RELEASE@@' | base64 --decode)",
      "code=DECOMMISSIONED; if [[ $action != cleanup ]]; then [[ ! -e $root/decommission.requested ]]; fi",
      "code=PACKAGE_MISMATCH; agent=$cw/bin/amazon-cloudwatch-agent; downloader=$cw/bin/config-downloader; control=$cw/bin/amazon-cloudwatch-agent-ctl",
      "check_package() { [[ -x $agent && -x $downloader && -x $control ]]; }",
      "observe() { version=null; service=null; local status measured; measured=$(timeout 10s \"$agent\" -version 2>/dev/null) || return; measured=$(sed -n 's/^\\(AmazonCloudWatchAgent \\)\\?CWAgent\\/\\([0-9][0-9.b]*\\)\\([ \\t].*\\)\\?$/\\2/p' <<< \"$measured\"); [[ -n $measured && ${#measured} -le 64 ]] && version=$(jq -cn --arg v \"$measured\" '$v'); status=$(systemctl show -p ActiveState --value amazon-cloudwatch-agent.service 2>/dev/null) || return; case $status in active) service='\"running\"';; inactive) service='\"stopped\"';; failed) service='\"failed\"';; esac; }"
    ],
    "prepare": [
      "code=DEPENDENCY_UNAVAILABLE; [[ -f /root/.aws/credentials ]]"
    ],
    "configure": [
      "check_package; observe",
      "code=CREDENTIAL_SOURCE_UNSAFE; [[ -f /root/.aws/credentials ]]",
      "printf '[credentials]\\nshared_credential_profile = \"default\"\\nshared_credential_file = \"/root/.aws/credentials\"\\n' > \"$root/common-config.toml\"",
      "stage=$(mktemp -d \"$root/download.XXXXXXXX\"); code=PRESET_FETCH_FAILED",
      "HOME=/root AWS_REGION=ap-southeast-1 AWS_EC2_METADATA_DISABLED=true timeout 90s \"$downloader\" -download-source 'ssm:{{ PresetName }}:{{ PresetVersion }}' -output-dir \"$stage\" -mode onPremise -config \"$root/common-config.toml\" -multi-config default >/dev/null 2>&1",
      "files=(\"$stage\"/*); [[ ${#files[@]} == 1 && -f ${files[0]} ]]; code=PRESET_MISMATCH; [[ $(sha256sum -- \"${files[0]}\" | cut -d ' ' -f1) == $(jq -r '.parameter.sha256' <<< \"$release\") ]]",
      "code=RESOURCE_MISMATCH; iface=$(ip -o route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\"dev\") {print $(i+1); exit}}'); [[ -n $iface && -d /sys/class/net/$iface ]] || iface=$(ls /sys/class/net | grep -v '^lo$' | head -n 1); [[ -n $iface && -d /sys/class/net/$iface ]]",
      "while IFS= read -r r; do selector=$(jq -r .selector <<< \"$r\"); kind=$(jq -r .kind <<< \"$r\"); case $kind in cpu) dimensions='[{\"name\":\"cpu\",\"value\":\"cpu-total\"}]';; interface) dimensions=$(jq -cn --arg s \"$iface\" '[{name:\"interface\",value:$s}]');; filesystem) actual=$(findmnt --json --target \"$selector\" --output TARGET,SOURCE,FSTYPE); dimensions=$(jq -ce '.filesystems|select(length==1)|.[0]|[{name:\"device\",value:(.source|split(\"/\")|last)},{name:\"fstype\",value:.fstype},{name:\"path\",value:.target}]' <<< \"$actual\");; *) exit 1;; esac; resources=$(jq -c --argjson r \"$r\" --argjson d \"$dimensions\" '.+[{id:$r.id,kind:$r.kind,dimensions:$d}]' <<< \"$resources\"); done < <(jq -c '.configuration.plugins[].resources[]' <<< \"$release\")",
      "code=CONFIGURE_FAILED; [[ ! -e $root/config.json ]] || cp -- \"$root/config.json\" \"$root/previous.json\"",
      "sed 's/${ServerId}/{{ ServerId }}/g;s/${ManagedNodeId}/{{ ManagedNodeId }}/g;s/${EnrollmentId}/{{ EnrollmentId }}/g' \"${files[0]}\" | sed \"s/\\\"eth0\\\"/\\\"$iface\\\"/g\" > \"$root/config.json\"; rm -f -- \"${files[0]}\"; rmdir -- \"$stage\"",
      "cp -- \"$root/common-config.toml\" \"$cw/etc/common-config.toml\"; chmod 0600 \"$cw/etc/common-config.toml\"; [[ ! -e $root/decommission.requested ]]",
      "HOME=/root AWS_REGION=ap-southeast-1 AWS_EC2_METADATA_DISABLED=true timeout 90s \"$control\" -a fetch-config -m onPremise -c \"file:$root/config.json\" -s >/dev/null 2>&1",
      "observe; [[ $service == '\"running\"' ]]; [[ ${#resources} -le 12000 ]]"
    ]
  },
  "windows": {
    "preamble": [
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $VerbosePreference='SilentlyContinue'; $DebugPreference='SilentlyContinue'",
      "$root='C:\\ProgramData\\InfraPulse Agent'; $cw='C:\\Program Files\\Amazon\\AmazonCloudWatchAgent'; $data='C:\\ProgramData\\Amazon\\AmazonCloudWatchAgent'; $action='@@ACTION@@'; $code='CONFIGURE_FAILED'; $version=$null; $state=$null; $resources=@(); $owns=$false; $lock=$null",
      "$release=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@RELEASE@@')))",
      "function Save($path,$value) { $bytes=[Text.UTF8Encoding]::new($false).GetBytes($value); [IO.File]::WriteAllBytes($path,$bytes) }",
      "function CheckPackage { foreach($key in @('agent','downloader','control')) { $path=Get-Variable -Name $key -ValueOnly; if (-not (Test-Path -LiteralPath $path)) { throw 'missing' } } }",
      "function Observe { $script:version=$null; $script:state=$null; $v=& $agent -version 2>$null; if ($LASTEXITCODE -eq 0 -and [string]$v -match '(?:AmazonCloudWatchAgent )?CWAgent/([0-9]+\\.[0-9]+\\.[0-9]+(?:\\.[0-9]+|b[0-9]+)?)') { $script:version=$Matches[1] }; $s=Get-Service -Name AmazonCloudWatchAgent -ErrorAction SilentlyContinue; if ($s -and $s.Status -eq 'Running') { $script:state='running' } elseif ($s -and $s.Status -eq 'Stopped') { $script:state='stopped' } }",
      "try {",
      "if ('{{ Platform }}' -cne 'windows' -or -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'platform' }",
      "if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }",
      "$code='CONFLICT'; $lock=[IO.File]::Open((Join-Path $root 'lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)",
      "$owner='{{ ServerId }}:{{ EnrollmentId }}:{{ ManagedNodeId }}'; Save (Join-Path $root 'owner') $owner",
      "$activePath=Join-Path $root 'active'; Save $activePath '{{ OperationId }}'; $owns=$true",
      "$marker=Join-Path $root 'decommission.requested'; $code='DECOMMISSIONED'; if ($action -cne 'cleanup' -and (Test-Path -LiteralPath $marker)) { throw 'decommissioned' }; $code='PACKAGE_MISMATCH'; $agent=Join-Path $cw 'amazon-cloudwatch-agent.exe'; $downloader=Join-Path $cw 'config-downloader.exe'; $control=Join-Path $cw 'amazon-cloudwatch-agent-ctl.ps1'"
    ],
    "prepare": [
      "$code='DEPENDENCY_UNAVAILABLE'; if (-not (Test-Path -LiteralPath 'C:\\Windows\\System32\\config\\systemprofile\\.aws\\credentials')) { throw 'no creds' }"
    ],
    "configure": [
      "CheckPackage; Observe",
      "$code='CREDENTIAL_SOURCE_UNSAFE'; $credential='C:\\Windows\\System32\\config\\systemprofile\\.aws\\credentials'; if (-not (Test-Path -LiteralPath $credential)) { throw 'no creds' }",
      "$common=Join-Path $root 'common-config.toml'; Save $common ('[credentials]'+[Environment]::NewLine+'shared_credential_profile = \"default\"'+[Environment]::NewLine+\"shared_credential_file = 'C:\\Windows\\System32\\config\\systemprofile\\.aws\\credentials'\"+[Environment]::NewLine)",
      "$stage=Join-Path $root ([guid]::NewGuid().ToString('N')); [void][IO.Directory]::CreateDirectory($stage); $code='PRESET_FETCH_FAILED'; $env:AWS_REGION='ap-southeast-1'; $env:AWS_EC2_METADATA_DISABLED='true'; & $downloader -download-source 'ssm:{{ PresetName }}:{{ PresetVersion }}' -output-dir $stage -mode onPremise -config $common -multi-config default *> $null; if ($LASTEXITCODE -ne 0) { throw 'download' }; $files=@(Get-ChildItem -LiteralPath $stage -Force); $code='PRESET_MISMATCH'; if ($files.Count -ne 1 -or $files[0].PSIsContainer -or $files[0].Length -gt 8192) { throw 'preset' }; if ((Get-FileHash -LiteralPath $files[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $release.parameter.sha256) { throw 'preset hash' }",
      "$code='RESOURCE_MISMATCH'; $drive=if ($env:SystemDrive) { $env:SystemDrive } else { 'C:' }; $nics=@(([System.Diagnostics.PerformanceCounterCategory]::new('Network Interface')).GetInstanceNames() | Where-Object { $_ -and $_ -notmatch '(?i)loopback|isatap|teredo|^_total$' }); $nic=$null; $best=-1; foreach ($cand in $nics) { try { $val=(Get-Counter -Counter ('\\Network Interface('+$cand+')\\Bytes Total/sec') -MaxSamples 1 -ErrorAction Stop).CounterSamples[0].CookedValue; if ($val -gt $best) { $best=$val; $nic=$cand } } catch {} }; if (-not $nic -and $nics.Count -gt 0) { $nic=$nics[0] }; if (-not $nic) { throw 'no nic' }",
      "foreach($plugin in $release.configuration.plugins) { foreach($r in $plugin.resources) { $d=@(); if ($r.kind -eq 'cpu') { $d=@(@{name='instance';value='_Total'},@{name='objectname';value='Processor'}) } elseif ($r.kind -eq 'memory') { $d=@(@{name='objectname';value='Memory'}) } elseif ($r.kind -eq 'filesystem') { $d=@(@{name='instance';value=$drive},@{name='objectname';value='LogicalDisk'}) } elseif ($r.kind -eq 'interface') { $d=@(@{name='instance';value=$nic},@{name='objectname';value='Network Interface'}) } else { throw 'kind' }; $resources+=@{id=$r.id;kind=$r.kind;dimensions=$d} } }",
      "$code='CONFIGURE_FAILED'; $config=Join-Path $root 'config.json'; if (Test-Path -LiteralPath $config) { Copy-Item -LiteralPath $config -Destination (Join-Path $root 'previous.json') -Force }; $text=[IO.File]::ReadAllText($files[0].FullName).Replace('${ServerId}','{{ ServerId }}').Replace('${ManagedNodeId}','{{ ManagedNodeId }}').Replace('${EnrollmentId}','{{ EnrollmentId }}').Replace('\"C:\"',(ConvertTo-Json $drive)).Replace('\"Microsoft Hyper-V Network Adapter\"',(ConvertTo-Json $nic)); Save $config $text; Remove-Item -LiteralPath $files[0].FullName -Force; Remove-Item -LiteralPath $stage -Recurse -Force",
      "if (-not (Test-Path -LiteralPath $data)) { New-Item -ItemType Directory -Path $data -Force | Out-Null }; Copy-Item -LiteralPath $common -Destination (Join-Path $data 'common-config.toml') -Force; if (Test-Path -LiteralPath $marker) { throw 'decommissioned' }; & $control -a fetch-config -m onPremise -c ('file:'+$config) -s *> $null; if ($LASTEXITCODE -ne 0) { throw 'control' }; Observe; if ($state -cne 'running') { throw 'observation' }"
    ],
    "epilogue": [
      "$ok=$true",
      "} catch { $ok=$false } finally { if ($action -cne 'prepare' -or -not $ok) { $summary=@{serverId='{{ ServerId }}';enrollmentId='{{ EnrollmentId }}';nodeId='{{ ManagedNodeId }}';operationId='{{ OperationId }}';platform='windows';configurationVersion='{{ ConfigurationVersion }}';step=$action;errorCode=$(if($ok){$null}else{$code});cloudWatchVersion=$version;serviceState=$state;resources=@($resources)}; $json=ConvertTo-Json -InputObject $summary -Depth 8 -Compress; if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384) { $ok=$false; $summary.resources=@(); $summary.errorCode='SUMMARY_TOO_LARGE'; $json=ConvertTo-Json -InputObject $summary -Depth 8 -Compress }; [Console]::WriteLine($json) }; if ($owns -and ($action -cne 'prepare' -or -not $ok) -and (Test-Path -LiteralPath $activePath)) { Remove-Item -LiteralPath $activePath -Force }; if($lock){$lock.Dispose()} }; if (-not $ok) { exit 1 }"
    ]
  }
}
