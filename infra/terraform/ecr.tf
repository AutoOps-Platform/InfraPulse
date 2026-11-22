# Only these two deployment-owned application repositories. Never import/adopt existing
# infrapulse-ingestion-gateway, infrapulse-management-backend or api-mb-account-name.
locals {
  ecr_public_roles        = toset(["management", "grafana"])
  ecr_public_registry_uri = "public.ecr.aws/h5u5b6t3"
}

resource "aws_ecrpublic_repository" "application" {
  provider = aws.ecr_public
  for_each = local.ecr_public_roles

  repository_name = "${local.name_prefix}-${each.key}"
  force_destroy   = false
  tags            = local.ownership_tags

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.aws_account_id == "491333778094" && var.deployment_id == "lab-20261118" && var.owner == "caophi562005"
      error_message = "Public repositories are restricted to the reviewed account, lab-20261118 deployment and owner."
    }

    postcondition {
      condition     = self.registry_id == "491333778094" && self.repository_uri == "${local.ecr_public_registry_uri}/${local.name_prefix}-${each.key}"
      error_message = "Actual ECR Public identity must match the reviewed account/alias and exact role repository before publication."
    }
  }
}
