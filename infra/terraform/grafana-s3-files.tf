locals {
  grafana_dashboard_storage_enabled = var.grafana_dashboard_storage_mode != "disabled"
  grafana_dashboard_mount_enabled   = var.grafana_dashboard_storage_mode == "mounted"
  grafana_dashboard_prefix          = "grafana/dashboards/"
  grafana_s3_files_service          = "elasticfilesystem.amazonaws.com"
  grafana_s3_files_arn_scope        = "arn:aws:s3files:${var.aws_region}:${var.aws_account_id}:file-system/*"
  grafana_sync_rule_scope           = "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/"
}

resource "aws_s3_bucket" "grafana_dashboards" {
  count         = local.grafana_dashboard_storage_enabled ? 1 : 0
  bucket        = "infrapulse-${var.deployment_id}-dash-${var.aws_account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "grafana_dashboards" {
  count                   = local.grafana_dashboard_storage_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.grafana_dashboards[count.index].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "grafana_dashboards" {
  count  = local.grafana_dashboard_storage_enabled ? 1 : 0
  bucket = aws_s3_bucket.grafana_dashboards[count.index].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "grafana_dashboards" {
  count  = local.grafana_dashboard_storage_enabled ? 1 : 0
  bucket = aws_s3_bucket.grafana_dashboards[count.index].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_notification" "grafana_dashboards" {
  count       = local.grafana_dashboard_storage_enabled ? 1 : 0
  bucket      = aws_s3_bucket.grafana_dashboards[count.index].id
  eventbridge = true
}

resource "aws_iam_role" "grafana_dashboard_sync" {
  count = local.grafana_dashboard_storage_enabled ? 1 : 0
  name  = "${local.name_prefix}-grafana-dash-sync"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = local.grafana_s3_files_service }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = local.grafana_s3_files_arn_scope }
      }
    }]
  })
}

resource "aws_iam_role_policy" "grafana_dashboard_sync" {
  count = local.grafana_dashboard_storage_enabled ? 1 : 0
  name  = "grafana-dashboard-sync"
  role  = aws_iam_role.grafana_dashboard_sync[count.index].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["s3:ListBucket", "s3:ListBucketVersions"]
        Resource  = aws_s3_bucket.grafana_dashboards[count.index].arn
        Condition = { StringEquals = { "aws:ResourceAccount" = var.aws_account_id } }
      },
      {
        Effect    = "Allow"
        Action    = ["s3:AbortMultipartUpload", "s3:DeleteObject*", "s3:GetObject*", "s3:List*", "s3:PutObject*"]
        Resource  = "${aws_s3_bucket.grafana_dashboards[count.index].arn}/${local.grafana_dashboard_prefix}*"
        Condition = { StringEquals = { "aws:ResourceAccount" = var.aws_account_id } }
      },
      {
        Effect    = "Allow"
        Action    = ["events:DeleteRule", "events:DisableRule", "events:EnableRule", "events:PutRule", "events:PutTargets", "events:RemoveTargets"]
        Resource  = "${local.grafana_sync_rule_scope}DO-NOT-DELETE-S3-Files*"
        Condition = { StringEquals = { "events:ManagedBy" = local.grafana_s3_files_service } }
      },
      {
        Effect   = "Allow"
        Action   = ["events:DescribeRule", "events:ListTargetsByRule"]
        Resource = "${local.grafana_sync_rule_scope}*"
      },
      {
        # EventBridge discovery actions do not support resource-level permissions.
        Effect    = "Allow"
        Action    = ["events:ListRuleNamesByTarget", "events:ListRules"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } }
      },
    ]
  })
}

resource "aws_s3files_file_system" "grafana_dashboards" {
  count    = local.grafana_dashboard_storage_enabled ? 1 : 0
  bucket   = aws_s3_bucket.grafana_dashboards[count.index].arn
  prefix   = local.grafana_dashboard_prefix
  role_arn = aws_iam_role.grafana_dashboard_sync[count.index].arn
  tags     = { Name = "${local.name_prefix}-grafana-dashboards" }

  depends_on = [
    aws_iam_role_policy.grafana_dashboard_sync,
    aws_s3_bucket_notification.grafana_dashboards,
    aws_s3_bucket_public_access_block.grafana_dashboards,
    aws_s3_bucket_server_side_encryption_configuration.grafana_dashboards,
    aws_s3_bucket_versioning.grafana_dashboards,
  ]
}

resource "aws_s3files_synchronization_configuration" "grafana_dashboards" {
  count          = local.grafana_dashboard_storage_enabled ? 1 : 0
  file_system_id = aws_s3files_file_system.grafana_dashboards[count.index].id

  import_data_rule {
    # The root rule uses the same absolute S3 prefix as the scoped filesystem.
    prefix         = local.grafana_dashboard_prefix
    size_less_than = 5242880
    trigger        = "ON_DIRECTORY_FIRST_ACCESS"
  }

  expiration_data_rule { days_after_last_access = 1 }
}

resource "aws_s3files_access_point" "grafana_dashboards" {
  count          = local.grafana_dashboard_storage_enabled ? 1 : 0
  file_system_id = aws_s3files_file_system.grafana_dashboards[count.index].id

  posix_user {
    uid = 472
    gid = 472
  }

  root_directory { path = "/live" }
}

resource "aws_security_group" "grafana_dashboard_mount" {
  count       = local.grafana_dashboard_storage_enabled ? 1 : 0
  name        = "${local.name_prefix}-grafana-dashboard-mount"
  description = "Private NFS mount target for Grafana dashboards"
  vpc_id      = aws_vpc.lab.id
}

resource "aws_vpc_security_group_ingress_rule" "grafana_dashboard_nfs" {
  count                        = local.grafana_dashboard_storage_enabled ? 1 : 0
  security_group_id            = aws_security_group.grafana_dashboard_mount[count.index].id
  referenced_security_group_id = aws_security_group.central.id
  description                  = "NFS from the ECS host only"
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

resource "aws_s3files_mount_target" "grafana_dashboards" {
  count           = local.grafana_dashboard_storage_enabled ? 1 : 0
  file_system_id  = aws_s3files_file_system.grafana_dashboards[count.index].id
  subnet_id       = aws_subnet.central.id
  security_groups = [aws_security_group.grafana_dashboard_mount[count.index].id]
  ip_address_type = "IPV4_ONLY"
}

resource "aws_iam_role_policy" "grafana_dashboard_reader" {
  count = local.grafana_dashboard_storage_enabled ? 1 : 0
  name  = "grafana-dashboard-reader"
  role  = aws_iam_role.ecs_task["grafana"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = "s3files:ClientMount"
        Resource  = aws_s3files_file_system.grafana_dashboards[count.index].arn
        Condition = { ArnEquals = { "s3files:AccessPointArn" = aws_s3files_access_point.grafana_dashboards[count.index].arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource  = "${aws_s3_bucket.grafana_dashboards[count.index].arn}/${local.grafana_dashboard_prefix}*"
        Condition = { StringEquals = { "aws:ResourceAccount" = var.aws_account_id } }
      },
      {
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.grafana_dashboards[count.index].arn
        Condition = {
          StringEquals = { "aws:ResourceAccount" = var.aws_account_id }
          StringLike   = { "s3:prefix" = "${local.grafana_dashboard_prefix}*" }
        }
      },
    ]
  })
}

resource "aws_s3files_file_system_policy" "grafana_dashboards" {
  count          = local.grafana_dashboard_storage_enabled ? 1 : 0
  file_system_id = aws_s3files_file_system.grafana_dashboards[count.index].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowGrafanaMountThroughAccessPoint"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.ecs_task["grafana"].arn }
        Action    = "s3files:ClientMount"
        Resource  = aws_s3files_file_system.grafana_dashboards[count.index].arn
        Condition = { ArnEquals = { "s3files:AccessPointArn" = aws_s3files_access_point.grafana_dashboards[count.index].arn } }
      },
      {
        Sid       = "DenyOtherMountPrincipals"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3files:ClientMount"
        Resource  = aws_s3files_file_system.grafana_dashboards[count.index].arn
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = aws_iam_role.ecs_task["grafana"].arn } }
      },
      {
        Sid       = "DenyMountOutsideAccessPoint"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3files:ClientMount"
        Resource  = aws_s3files_file_system.grafana_dashboards[count.index].arn
        Condition = { ArnNotEquals = { "s3files:AccessPointArn" = aws_s3files_access_point.grafana_dashboards[count.index].arn } }
      },
      {
        Sid       = "DenyClientWriteAndRoot"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3files:ClientWrite", "s3files:ClientRootAccess"]
        Resource  = aws_s3files_file_system.grafana_dashboards[count.index].arn
      },
    ]
  })
}
