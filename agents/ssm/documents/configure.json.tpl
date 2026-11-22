{
  "linux": {
    "preamble": [
      "#!/bin/bash",
      "set +x; set +v; set -euo pipefail; umask 077",
      "export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C",
      "root=/var/lib/infrapulse-agent; bin=/usr/local/bin/alloy; unit=infrapulse-alloy.service; action=@@ACTION@@; code=CONFIGURE_FAILED; version=null; service=null; resources='[]'; owns=false",
      "summary() { local result=$?; trap - EXIT; if [[ ${#resources} -gt 12000 ]]; then resources='[]'; code=SUMMARY_TOO_LARGE; result=1; fi; if [[ $action != prepare || $result != 0 ]]; then jq -cn --arg server '{{ ServerId }}' --arg enrollment '{{ EnrollmentId }}' --arg node '{{ ManagedNodeId }}' --arg operation '{{ OperationId }}' --arg config '{{ ConfigurationVersion }}' --arg step \"$action\" --arg error \"$code\" --argjson result \"$result\" --argjson version \"$version\" --argjson service \"$service\" --argjson resources \"$resources\" '{serverId:$server,enrollmentId:$enrollment,nodeId:$node,operationId:$operation,platform:\"linux\",configurationVersion:$config,step:$step,errorCode:(if $result==0 then null else $error end),cloudWatchVersion:$version,serviceState:$service,resources:$resources}' || printf '%s\\n' '{\"step\":\"prepare\",\"errorCode\":\"DEPENDENCY_UNAVAILABLE\",\"cloudWatchVersion\":null,\"serviceState\":null,\"resources\":[]}'; fi; if $owns && [[ $action != prepare || $result != 0 ]]; then rm -f -- \"$root/active\"; fi; exit \"$result\"; }; trap summary EXIT",
      "[[ $(id -u) == 0 && '{{ Platform }}' == linux ]]",
      "if ! command -v jq >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null 2>&1 || true; fi",
      "for tool in jq flock curl sha256sum systemctl; do command -v \"$tool\" >/dev/null; done",
      "mkdir -p -m 0700 -- \"$root\" \"$root/alloy-data\"",
      "exec 9>\"$root/lock\"; code=CONFLICT; flock -w 30 9",
      "owner='{{ ServerId }}:{{ EnrollmentId }}:{{ ManagedNodeId }}'",
      "printf '%s' \"$owner\" > \"$root/owner\"",
      "printf '%s' '{{ OperationId }}' > \"$root/active\"; owns=true",
      "release=$(printf '%s' '@@RELEASE@@' | base64 --decode)",
      "code=DECOMMISSIONED; if [[ $action != cleanup ]]; then [[ ! -e $root/decommission.requested ]]; fi",
      "observe() { version=null; service=null; local status measured; if [[ -x $bin ]]; then measured=$(\"$bin\" --version 2>/dev/null | sed -n 's/.*version v\\?\\([0-9][0-9.]*\\).*/\\1/p' | head -n 1) || true; [[ -n $measured && ${#measured} -le 64 ]] && version=$(jq -cn --arg v \"$measured\" '$v'); fi; status=$(systemctl show -p ActiveState --value \"$unit\" 2>/dev/null) || return; case $status in active) service='\"running\"';; inactive) service='\"stopped\"';; failed) service='\"failed\"';; esac; }"
    ],
    "prepare": [
      "code=DEPENDENCY_UNAVAILABLE; [[ -f /root/.aws/credentials ]]"
    ],
    "configure": [
      "code=CREDENTIAL_SOURCE_UNSAFE; [[ -f /root/.aws/credentials ]]",
      "systemctl disable --now amazon-cloudwatch-agent.service >/dev/null 2>&1 || true",
      "code=PACKAGE_MISMATCH; want_ver=$(jq -r '.alloy.version' <<< \"$release\"); alloy_url=$(jq -r '.alloy.url' <<< \"$release\"); alloy_sha=$(jq -r '.alloy.sha256' <<< \"$release\"); observe",
      "if [[ $version != \"\\\"$want_ver\\\"\" ]]; then stage=$(mktemp -d \"$root/alloy.XXXXXXXX\"); trap 'rm -rf -- \"$stage\"' RETURN 2>/dev/null || true; curl -fsSL --proto '=https' --tlsv1.2 --max-time 180 \"$alloy_url\" -o \"$stage/alloy.zip\" >/dev/null 2>&1; [[ $(sha256sum -- \"$stage/alloy.zip\" | cut -d ' ' -f1) == \"$alloy_sha\" ]]; if command -v unzip >/dev/null 2>&1; then unzip -qo \"$stage/alloy.zip\" -d \"$stage\" >/dev/null 2>&1; else python3 -c \"import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])\" \"$stage/alloy.zip\" \"$stage\" >/dev/null 2>&1; fi; install -m 0755 \"$stage/alloy-linux-amd64\" \"$bin\"; rm -rf -- \"$stage\"; fi",
      "code=PRESET_MISMATCH; preset_json=$(jq -r '.presetJson' <<< \"$release\"); [[ $(printf '%s' \"$preset_json\" | sha256sum | cut -d ' ' -f1) == $(jq -r '.parameter.sha256' <<< \"$release\") ]]",
      "code=CONFIGURE_FAILED; [[ ! -e $root/config.alloy ]] || cp -- \"$root/config.alloy\" \"$root/previous.alloy\"",
      "jq -r '.config' <<< \"$preset_json\" | sed 's/${ServerId}/{{ ServerId }}/g;s/${ManagedNodeId}/{{ ManagedNodeId }}/g;s/${EnrollmentId}/{{ EnrollmentId }}/g' > \"$root/config.alloy\"; chmod 0600 \"$root/config.alloy\"",
      "resources=$(jq -c '[.configuration.plugins[].resources[] | {id:.id,kind:.kind,dimensions:.dimensions}]' <<< \"$release\")",
      "cat <<'IP_CREDS_EOF' > \"$root/ssm-creds.sh\"",
      "#!/bin/bash",
      "set -euo pipefail",
      "f=/root/.aws/credentials",
      "get_val() { awk -v key=\"$1\" '/^\\[default\\][[:space:]]*$/{s=1;next}/^\\[/{s=0}s{i=index($0,\"=\");if(i>0){k=substr($0,1,i-1);v=substr($0,i+1);gsub(/^[[:space:]]+|[[:space:]]+$/,\"\",k);gsub(/^[[:space:]]+|[[:space:]]+$/,\"\",v);if(k==key){print v;exit}}}' \"$f\"; }",
      "ak=$(get_val aws_access_key_id); sk=$(get_val aws_secret_access_key); st=$(get_val aws_session_token); [[ -n $ak && -n $sk && -n $st ]]",
      "exp=$(date -u -d '+15 minutes' '+%Y-%m-%dT%H:%M:%SZ')",
      "jq -cn --arg ak \"$ak\" --arg sk \"$sk\" --arg st \"$st\" --arg exp \"$exp\" '{Version:1,AccessKeyId:$ak,SecretAccessKey:$sk,SessionToken:$st,Expiration:$exp}'",
      "IP_CREDS_EOF",
      "chmod 0700 \"$root/ssm-creds.sh\"",
      "printf '%s\\n' '[profile infrapulse-ssm]' 'region = ap-southeast-1' \"credential_process = $root/ssm-creds.sh\" > \"$root/aws-config\"; chmod 0600 \"$root/aws-config\"",
      "printf '%s\\n' '[Unit]' 'Description=InfraPulse Grafana Alloy' 'After=network-online.target amazon-ssm-agent.service' 'Wants=network-online.target' '' '[Service]' 'Type=simple' 'User=root' 'Environment=AWS_REGION=ap-southeast-1' 'Environment=AWS_EC2_METADATA_DISABLED=true' 'Environment=AWS_SDK_LOAD_CONFIG=true' \"Environment=AWS_CONFIG_FILE=$root/aws-config\" 'Environment=AWS_SHARED_CREDENTIALS_FILE=/dev/null' 'Environment=AWS_PROFILE=infrapulse-ssm' \"ExecStart=$bin run --storage.path=$root/alloy-data --disable-reporting $root/config.alloy\" 'Restart=always' 'RestartSec=5' '' '[Install]' 'WantedBy=multi-user.target' > \"/etc/systemd/system/$unit\"",
      "[[ ! -e $root/decommission.requested ]]",
      "systemctl daemon-reload >/dev/null 2>&1; systemctl enable \"$unit\" >/dev/null 2>&1; systemctl restart \"$unit\" >/dev/null 2>&1; sleep 2",
      "observe; [[ $service == '\"running\"' && $version == \"\\\"$want_ver\\\"\" ]]; [[ ${#resources} -le 12000 ]]"
    ]
  },
  "windows": {
    "preamble": [
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $VerbosePreference='SilentlyContinue'; $DebugPreference='SilentlyContinue'",
      "$root='C:\\ProgramData\\InfraPulse Agent'; $alloyDir='C:\\Program Files\\GrafanaLabs\\Alloy'; $bin=Join-Path $alloyDir 'alloy-windows-amd64.exe'; $svc='Alloy'; $action='@@ACTION@@'; $code='CONFIGURE_FAILED'; $version=$null; $state=$null; $resources=@(); $owns=$false; $lock=$null",
      "$release=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@RELEASE@@')))",
      "function Save($path,$value) { $bytes=[Text.UTF8Encoding]::new($false).GetBytes($value); [IO.File]::WriteAllBytes($path,$bytes) }",
      "function ResolveAlloyBin { foreach($p in @((Join-Path $alloyDir 'alloy-windows-amd64.exe'),(Join-Path $alloyDir 'alloy.exe'))) { if (Test-Path -LiteralPath $p) { return $p } }; return $null }",
      "function Observe { $script:version=$null; $script:state=$null; $exe=ResolveAlloyBin; if ($exe) { $v=& $exe --version 2>$null; if ($LASTEXITCODE -eq 0 -and ([string]($v -join ' ')) -match 'version v?([0-9]+\\.[0-9]+\\.[0-9]+)') { $script:version=$Matches[1] } }; $s=Get-Service -Name $svc -ErrorAction SilentlyContinue; if ($s -and $s.Status -eq 'Running') { $script:state='running' } elseif ($s -and $s.Status -eq 'Stopped') { $script:state='stopped' } }",
      "try {",
      "if ('{{ Platform }}' -cne 'windows' -or -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'platform' }",
      "if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }",
      "$code='CONFLICT'; $lock=[IO.File]::Open((Join-Path $root 'lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)",
      "$owner='{{ ServerId }}:{{ EnrollmentId }}:{{ ManagedNodeId }}'; Save (Join-Path $root 'owner') $owner",
      "$activePath=Join-Path $root 'active'; Save $activePath '{{ OperationId }}'; $owns=$true",
      "$marker=Join-Path $root 'decommission.requested'; $code='DECOMMISSIONED'; if ($action -cne 'cleanup' -and (Test-Path -LiteralPath $marker)) { throw 'decommissioned' }"
    ],
    "prepare": [
      "$code='DEPENDENCY_UNAVAILABLE'; if (-not (Test-Path -LiteralPath 'C:\\Windows\\System32\\config\\systemprofile\\.aws\\credentials')) { throw 'no creds' }"
    ],
    "configure": [
      "$code='CREDENTIAL_SOURCE_UNSAFE'; $credential='C:\\Windows\\System32\\config\\systemprofile\\.aws\\credentials'; if (-not (Test-Path -LiteralPath $credential)) { throw 'no creds' }",
      "try { Stop-Service -Name AmazonCloudWatchAgent -Force -ErrorAction SilentlyContinue; Set-Service -Name AmazonCloudWatchAgent -StartupType Disabled -ErrorAction SilentlyContinue } catch {}",
      "$code='PRESET_MISMATCH'; $presetBytes=[Text.UTF8Encoding]::new($false).GetBytes([string]$release.presetJson); $sha=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($presetBytes)).Replace('-','').ToLowerInvariant(); if ($sha -cne $release.parameter.sha256) { throw 'preset hash' }; $presetObj=ConvertFrom-Json $release.presetJson",
      "$code='CONFIGURE_FAILED'; $config=Join-Path $root 'config.alloy'; if (Test-Path -LiteralPath $config) { Copy-Item -LiteralPath $config -Destination (Join-Path $root 'previous.alloy') -Force }; $cfgText=([string]$presetObj.config).Replace('${ServerId}','{{ ServerId }}').Replace('${ManagedNodeId}','{{ ManagedNodeId }}').Replace('${EnrollmentId}','{{ EnrollmentId }}'); Save $config $cfgText",
      "$code='PACKAGE_MISMATCH'; $wantVer=[string]$release.alloy.version; Observe; if ($version -cne $wantVer -or -not (Get-Service -Name $svc -ErrorAction SilentlyContinue)) { $stage=Join-Path $root ('alloy-'+[guid]::NewGuid().ToString('N')); [void][IO.Directory]::CreateDirectory($stage); try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $zip=Join-Path $stage 'alloy.zip'; Invoke-WebRequest -UseBasicParsing -Uri $release.alloy.url -OutFile $zip -TimeoutSec 180 *> $null; if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $release.alloy.sha256) { throw 'alloy hash' }; Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force *> $null; $inst=Get-ChildItem -LiteralPath $stage -Filter '*.exe' | Select-Object -First 1; if (-not $inst) { throw 'no installer' }; $p=Start-Process -FilePath $inst.FullName -ArgumentList '/S',('/CONFIG=\"'+$config+'\"'),'/DISABLEREPORTING=yes' -Wait -PassThru; if ($p.ExitCode -ne 0) { throw 'install failed' } } finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue } }",
      "$code='CONFIGURE_FAILED'; foreach($plugin in $release.configuration.plugins) { foreach($r in $plugin.resources) { $resources+=@{id=$r.id;kind=$r.kind;dimensions=@($r.dimensions)} } }",
      "$credDir='C:\\ProgramData\\InfraPulse'; if (-not (Test-Path -LiteralPath $credDir)) { New-Item -ItemType Directory -Path $credDir -Force | Out-Null }; $credScript=Join-Path $credDir 'ssm-creds.ps1'; $credCfg=Join-Path $credDir 'aws-config'; $credBody=\"`$ErrorActionPreference='Stop'`r`n`$f='C:\\Windows\\System32\\config\\systemprofile\\.aws\\credentials'`r`n`$inDefault=`$false; `$m=@{}`r`nforeach(`$line in [IO.File]::ReadAllLines(`$f)) { `$t=`$line.Trim(); if (`$t -match '^\\[(.+)\\]$') { `$inDefault=(`$Matches[1] -eq 'default'); continue }; if (`$inDefault -and `$t -match '^([a-z0-9_]+)\\s*=\\s*(.+)$') { `$m[`$Matches[1]]=`$Matches[2].Trim() } }`r`nif (-not `$m['aws_access_key_id'] -or -not `$m['aws_secret_access_key'] -or -not `$m['aws_session_token']) { throw 'empty creds' }`r`n`$exp=(Get-Date).ToUniversalTime().AddMinutes(15).ToString('yyyy-MM-ddTHH:mm:ssZ')`r`n[Console]::WriteLine(([ordered]@{Version=1;AccessKeyId=`$m['aws_access_key_id'];SecretAccessKey=`$m['aws_secret_access_key'];SessionToken=`$m['aws_session_token'];Expiration=`$exp} | ConvertTo-Json -Compress))\"; Save $credScript $credBody; Save $credCfg (\"[profile infrapulse-ssm]`r`nregion = ap-southeast-1`r`ncredential_process = C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $credScript`r`n\"); $svcKey='HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Alloy'; if (Test-Path -LiteralPath $svcKey) { New-ItemProperty -Path $svcKey -Name 'Environment' -PropertyType MultiString -Value @('AWS_REGION=ap-southeast-1','AWS_EC2_METADATA_DISABLED=true','AWS_SDK_LOAD_CONFIG=true',\"AWS_CONFIG_FILE=$credCfg\",\"AWS_SHARED_CREDENTIALS_FILE=$credDir\\no-static-creds\",'AWS_PROFILE=infrapulse-ssm') -Force | Out-Null }; if (Test-Path -LiteralPath 'C:\\Program Files\\GrafanaLabs\\Alloy\\config.alloy') { Copy-Item -LiteralPath $config -Destination 'C:\\Program Files\\GrafanaLabs\\Alloy\\config.alloy' -Force }",
      "if (Test-Path -LiteralPath $marker) { throw 'decommissioned' }; Set-Service -Name $svc -StartupType Automatic -ErrorAction SilentlyContinue; Restart-Service -Name $svc -Force *> $null; Start-Sleep -Seconds 3; Observe; if ($state -cne 'running' -or $version -cne $wantVer) { throw 'observation' }"
    ],
    "epilogue": [
      "$ok=$true",
      "} catch { $ok=$false } finally { if ($action -cne 'prepare' -or -not $ok) { $summary=@{serverId='{{ ServerId }}';enrollmentId='{{ EnrollmentId }}';nodeId='{{ ManagedNodeId }}';operationId='{{ OperationId }}';platform='windows';configurationVersion='{{ ConfigurationVersion }}';step=$action;errorCode=$(if($ok){$null}else{$code});cloudWatchVersion=$version;serviceState=$state;resources=@($resources)}; $json=ConvertTo-Json -InputObject $summary -Depth 8 -Compress; if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384) { $ok=$false; $summary.resources=@(); $summary.errorCode='SUMMARY_TOO_LARGE'; $json=ConvertTo-Json -InputObject $summary -Depth 8 -Compress }; [Console]::WriteLine($json) }; if ($owns -and ($action -cne 'prepare' -or -not $ok) -and (Test-Path -LiteralPath $activePath)) { Remove-Item -LiteralPath $activePath -Force }; if($lock){$lock.Dispose()} }; if (-not $ok) { exit 1 }"
    ]
  }
}
