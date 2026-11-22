provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.ownership_tags
  }
}

# ECR Public's control plane is us-east-1; the Singapore provider stays unchanged.
provider "aws" {
  alias               = "ecr_public"
  region              = "us-east-1"
  allowed_account_ids = ["491333778094"]

  default_tags {
    tags = local.ownership_tags
  }
}

locals {
  name_prefix = "infrapulse-${var.deployment_id}"
  ownership_tags = {
    Project              = "InfraPulse"
    Environment          = var.deployment_id
    InfraPulseDeployment = var.deployment_id
    Owner                = var.owner
  }

  metric_namespace           = "InfraPulse/Lab"
  eligibility_value          = var.deployment_id
  config_document_name       = "InfraPulse-${var.deployment_id}-Configure"
  decommission_document_name = "InfraPulse-${var.deployment_id}-Decommission"
  linux_preset_name          = "/infrapulse/${var.deployment_id}/presets/linux"
  windows_preset_name        = "/infrapulse/${var.deployment_id}/presets/windows"
}
