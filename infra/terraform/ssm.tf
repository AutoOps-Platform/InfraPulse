# SOURCE ONLY. No publication/apply is authorized by this source change.
# Existing associations must be stopped/retired under a separate operational plan
# BEFORE publishing the single-command documents. Forgetting state does not stop AWS.
locals {
  ssm_source            = var.publish_ssm_source ? { owned = true } : {}
  compiled_configure    = var.publish_ssm_source ? file("${path.module}/../../deploy/generated/ssm/configure.json") : null
  compiled_decommission = var.publish_ssm_source ? file("${path.module}/../../deploy/generated/ssm/decommission.json") : null
  compiled_presets      = var.publish_ssm_source ? jsondecode(file("${path.module}/../../deploy/generated/ssm/presets.json")) : {}
  native_presets        = var.publish_ssm_source ? local.compiled_presets : {}
  document_utf8_bytes = var.publish_ssm_source ? { for k, v in { configure = local.compiled_configure, decommission = local.compiled_decommission } : k =>
    length(base64encode(v)) / 4 * 3 - (endswith(base64encode(v), "==") ? 2 : endswith(base64encode(v), "=") ? 1 : 0)
  } : {}
  preset_utf8_bytes = { for k, v in local.native_presets : k =>
    length(base64encode(v.value)) / 4 * 3 - (endswith(base64encode(v.value), "==") ? 2 : endswith(base64encode(v.value), "=") ? 1 : 0)
  }
}

resource "aws_ssm_document" "configure" {
  for_each        = local.ssm_source
  name            = local.config_document_name
  document_type   = "Command"
  document_format = "JSON"
  content         = local.compiled_configure
  tags            = local.ownership_tags
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.association_retirement_confirmed && var.deployment_id == "lab-20261118" && jsondecode(local.compiled_configure).schemaVersion == "2.2" && local.document_utf8_bytes.configure <= 65536
      error_message = "Retire any existing automatic association under a separate approved operational plan before publishing the bounded lab Command protocol."
    }
  }
}
resource "aws_ssm_document" "decommission" {
  for_each        = local.ssm_source
  name            = local.decommission_document_name
  document_type   = "Command"
  document_format = "JSON"
  content         = local.compiled_decommission
  tags            = local.ownership_tags
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.association_retirement_confirmed && var.deployment_id == "lab-20261118" && jsondecode(local.compiled_decommission).schemaVersion == "2.2" && local.document_utf8_bytes.decommission <= 65536
      error_message = "Explicit association retirement and bounded lab Command protocol are required; this source does not stop or destroy an association."
    }
  }
}
resource "aws_ssm_parameter" "preset" {
  for_each = local.native_presets
  name     = each.value.name
  type     = "String"
  tier     = each.value.tier
  value    = each.value.value
  tags     = local.ownership_tags
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = contains([local.linux_preset_name, local.windows_preset_name], each.value.name) && sha256(each.value.value) == each.value.sha256 && contains(["Standard", "Advanced"], each.value.tier) && local.preset_utf8_bytes[each.key] <= (each.value.tier == "Standard" ? 4096 : 8192)
      error_message = "Canonical preset name, explicit tier and exact UTF-8 hash must agree."
    }
    postcondition {
      condition     = tostring(self.version) == each.value.version
      error_message = "Actual published Parameter Store version differs from the canonical pinned version. Stop; do not substitute latest."
    }
  }
}
# Do not turn source retirement into an implicit destroy of a real association.
# Terraform >=1.10 supports this explicit non-destructive state handoff.
removed {
  from = aws_ssm_association.configure
  lifecycle { destroy = false }
}
