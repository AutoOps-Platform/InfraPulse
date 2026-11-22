# Secret attachment: save to an Administrator/SYSTEM-only local file, run in a
# fresh non-transcribed PowerShell process, then delete it. No secure erase claim.
# Never paste this file into history, a transcript, a URL, or a support log.
# Registers SSM only. REGISTERED is not monitoring Success; never rerun to retry activation.
@@CANONICAL_METADATA@@
function Initialize-InfraPulseIntent {
    $script:ServerId = '{{SERVER_ID}}'
    $script:EnrollmentId = '{{ENROLLMENT_ID}}'
    $script:Generation = '{{GENERATION}}'
    $script:ActivationId = '{{ACTIVATION_ID}}'
    $script:Region = '{{REGION}}'
    $script:PresetHash = '{{PRESET_HASH}}'
    $script:ActivationCode = '{{ACTIVATION_CODE}}'
}
@@BOOTSTRAP_BODY@@
