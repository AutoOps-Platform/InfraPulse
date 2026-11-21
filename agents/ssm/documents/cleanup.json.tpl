{
  "linux": [
    "code=CLEANUP_FAILED; printf '%s' '{{ OperationId }}' > \"$root/decommission.requested\"; sync -f \"$root/decommission.requested\"; sync -f \"$root\"",
    "check_package; observe; timeout --signal=TERM --kill-after=5s 90s \"$control\" -a stop -m onPremise >/dev/null 2>&1; observe; [[ $service == '\"stopped\"' ]]",
    "# Deliberately retain the owned package, previous config and durable fence. Never remove SSM."
  ],
  "windows": [
    "$code='CLEANUP_FAILED'; Save $marker '{{ OperationId }}'; CheckPackage; Observe; & $control -a stop -m onPremise *> $null; if ($LASTEXITCODE -ne 0) { throw 'stop' }; Observe; if ($state -cne 'stopped') { throw 'stop observation' }",
    "# Retain the owned package, previous config and durable fence; never remove SSM."
  ]
}
