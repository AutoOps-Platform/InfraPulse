{
  "linux": [
    "code=CLEANUP_FAILED; printf '%s' '{{ OperationId }}' > \"$root/decommission.requested\"; sync -f \"$root/decommission.requested\"; sync -f \"$root\"",
    "systemctl disable --now infrapulse-docker-state.timer infrapulse-docker-state.service infrapulse-ssl-certs.timer infrapulse-ssl-certs.service \"$unit\" >/dev/null 2>&1 || true; observe; [[ $service == '\"stopped\"' || $service == 'null' ]]",
    "# Deliberately retain the owned package, previous config and durable fence. Never remove SSM."
  ],
  "windows": [
    "$code='CLEANUP_FAILED'; Save $marker '{{ OperationId }}'; try { Unregister-ScheduledTask -TaskName 'InfraPulse-DockerState' -Confirm:$false -ErrorAction SilentlyContinue } catch {}; try { Unregister-ScheduledTask -TaskName 'InfraPulse-SslCerts' -Confirm:$false -ErrorAction SilentlyContinue } catch {}; try { Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue; Set-Service -Name $svc -StartupType Disabled -ErrorAction SilentlyContinue } catch {}; Observe; if ($state -cne 'stopped' -and $null -ne $state) { throw 'stop observation' }",
    "# Retain the owned package, previous config and durable fence; never remove SSM."
  ]
}
