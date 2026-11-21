#!/bin/bash
# Secret attachment: save privately (0600), run as root from a local file, then
# delete the downloaded file. Deletion is best effort, not secure disk erasure.
# Never paste this file into shell history, tracing, a URL, or a support log.
# Registers SSM only. REGISTERED is not monitoring Success; never rerun to retry activation.
@@CANONICAL_METADATA@@
load_bootstrap_intent() {
  server_id='{{SERVER_ID}}'
  enrollment_id='{{ENROLLMENT_ID}}'
  generation='{{GENERATION}}'
  activation_id='{{ACTIVATION_ID}}'
  region='{{REGION}}'
  preset_hash='{{PRESET_HASH}}'
  activation_code='{{ACTIVATION_CODE}}'
}
@@BOOTSTRAP_BODY@@
