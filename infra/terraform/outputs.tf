output "deployment_environment" {
  description = "Protected nonsecret deployment inputs with only actual published document and available per-OS preset versions. Not native/effective-IAM proof."
  value = merge({
    AWS_REGION                            = var.aws_region
    INFRAPULSE_AWS_ACCOUNT_ID             = var.aws_account_id
    INFRAPULSE_DEPLOYMENT_ID              = var.deployment_id
    INFRAPULSE_OWNER                      = var.owner
    INFRAPULSE_HYBRID_ROLE_NAME           = aws_iam_role.hybrid.name
    INFRAPULSE_ELIGIBILITY_VALUE          = local.eligibility_value
    INFRAPULSE_CONFIG_DOCUMENT_NAME       = local.config_document_name
    INFRAPULSE_DECOMMISSION_DOCUMENT_NAME = local.decommission_document_name
    INFRAPULSE_LINUX_PRESET_NAME          = local.linux_preset_name
    INFRAPULSE_WINDOWS_PRESET_NAME        = local.windows_preset_name
    INFRAPULSE_METRIC_NAMESPACE           = local.metric_namespace
    }, var.publish_ssm_source ? {
    INFRAPULSE_CONFIG_DOCUMENT_VERSION       = aws_ssm_document.configure["owned"].document_version
    INFRAPULSE_DECOMMISSION_DOCUMENT_VERSION = aws_ssm_document.decommission["owned"].document_version
    } : {}, {
    for platform, preset in aws_ssm_parameter.preset :
    "INFRAPULSE_${upper(platform)}_PRESET_VERSION" => tostring(preset.version)
  })
}

output "central_instance_id" {
  description = "Central host only; not a hybrid inventory node."
  value       = aws_instance.central.id
}

output "vpc_id" {
  description = "New lab VPC; no old-lab migration."
  value       = aws_vpc.lab.id
}

output "subnet_id" {
  description = "Central outbound public subnet."
  value       = aws_subnet.central.id
}

output "security_group_id" {
  description = "Central zero-ingress security group."
  value       = aws_security_group.central.id
}

output "metric_namespace" {
  value = local.metric_namespace
}

output "hybrid_role_name" {
  value = aws_iam_role.hybrid.name
}

output "eligibility_value" {
  value = local.eligibility_value
}

output "ecr_public_registry" {
  description = "Actual repository-derived public registry identity; verify against AWS before any push. ECR Public auth/control plane is us-east-1, not Singapore."
  value = {
    registry_id = aws_ecrpublic_repository.application["management"].registry_id
    uri         = join("/", slice(split("/", aws_ecrpublic_repository.application["management"].repository_uri), 0, 2))
    region      = "us-east-1"
  }
}

output "ecr_public_repository_urls" {
  description = "Existing deployment-owned Management and Grafana ECR Public repository URLs; not image publication evidence."
  value       = { for role, repository in aws_ecrpublic_repository.application : role => repository.repository_uri }
}

output "ecr_public_repository_arns" {
  description = "Actual ARNs for only this deployment's ECR Public repositories. No unrelated repositories are adopted."
  value       = { for role, repository in aws_ecrpublic_repository.application : role => repository.arn }
}

output "ecs_cluster_name" {
  description = "Cluster on the single central EC2 host."
  value       = aws_ecs_cluster.central.name
}

output "ecs_runtime_images" {
  description = "Digest-pinned runtime images configured for the two ECS services."
  value       = local.ecs_images
}

output "grafana_dashboard_publish" {
  description = "Public release target for canonical Grafana dashboard JSON; null when storage is disabled."
  value = local.grafana_dashboard_storage_enabled ? {
    version       = 1
    account_id    = var.aws_account_id
    region        = var.aws_region
    deployment_id = var.deployment_id
    bucket        = aws_s3_bucket.grafana_dashboards[0].id
    prefix        = local.grafana_dashboard_prefix
  } : null
}

output "bootstrap_bucket_name" {
  description = "Private ephemeral S3 bucket for one-time presigned bootstrap scripts (auto-expired via S3 Lifecycle)."
  value       = aws_s3_bucket.bootstrap.id
}

output "native_qualification_status" {
  description = "No document/preset/native qualification or effective-IAM evidence exists in I2."
  value       = "NOT RUN"
}
