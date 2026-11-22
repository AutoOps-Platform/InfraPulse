locals {
  ssm_arn_prefix   = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}"
  managed_node_arn = "${local.ssm_arn_prefix}:managed-instance/mi-*"
  approved_document_arns = [
    "${local.ssm_arn_prefix}:document/${local.config_document_name}",
    "${local.ssm_arn_prefix}:document/${local.decommission_document_name}",
  ]
  approved_preset_arns = [
    "${local.ssm_arn_prefix}:parameter${local.linux_preset_name}",
    "${local.ssm_arn_prefix}:parameter${local.windows_preset_name}",
  ]
  regional_condition = {
    StringEquals = { "aws:RequestedRegion" = var.aws_region }
  }
  owned_condition = {
    StringEquals = {
      "aws:RequestedRegion"                  = var.aws_region
      "aws:ResourceTag/Project"              = "InfraPulse"
      "aws:ResourceTag/Environment"          = var.deployment_id
      "aws:ResourceTag/InfraPulseDeployment" = var.deployment_id
    }
  }
}

resource "aws_iam_role" "hybrid" {
  name        = "${local.name_prefix}-hybrid"
  description = "Hybrid SSM nodes only; exact preset reads and namespace-limited metrics"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ssm.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "${local.ssm_arn_prefix}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "hybrid_node" {
  name = "${local.name_prefix}-hybrid-node"
  role = aws_iam_role.hybrid.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "OwnedNodeAgentStatus"
        Effect = "Allow"
        Action = [
          "ssm:ListInstanceAssociations",
          "ssm:UpdateAssociationStatus",
          "ssm:UpdateInstanceAssociationStatus",
          "ssm:UpdateInstanceInformation",
        ]
        Resource  = local.managed_node_arn
        Condition = local.owned_condition
      },
      {
        Sid       = "ApprovedAgentDocuments"
        Effect    = "Allow"
        Action    = ["ssm:GetDocument", "ssm:DescribeDocument"]
        Resource  = local.approved_document_arns
        Condition = local.regional_condition
      },
      {
        Sid       = "OfficialCloudWatchDistributorPackage"
        Effect    = "Allow"
        Action    = ["ssm:GetDocument", "ssm:DescribeDocument"]
        Resource  = "arn:aws:ssm:${var.aws_region}::document/AmazonCloudWatchAgent"
        Condition = local.regional_condition
      },
      {
        # Distributor agent manifest/result APIs have no resource-level scope.
        Sid       = "RegionalDistributorAgentProtocol"
        Effect    = "Allow"
        Action    = ["ssm:GetManifest", "ssm:PutConfigurePackageResult"]
        Resource  = "*"
        Condition = local.regional_condition
      },
      {
        # No resource scope for this agent assignment-listing action. This is
        # not DescribeInstanceInformation/ListTags identity discovery.
        Sid       = "AgentAssignmentListing"
        Effect    = "Allow"
        Action    = "ssm:ListAssociations"
        Resource  = "*"
        Condition = local.regional_condition
      },
      {
        # These three message gateway actions have no resource ARN scope.
        Sid    = "AgentMessageChannels"
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
        ]
        Resource  = "*"
        Condition = local.regional_condition
      },
      {
        # Unlike the other three channel actions, OpenDataChannel supports a
        # required SSM session ARN. This is account/region, not per-node scope.
        Sid       = "RegionalAgentDataSessions"
        Effect    = "Allow"
        Action    = "ssmmessages:OpenDataChannel"
        Resource  = "${local.ssm_arn_prefix}:session/*"
        Condition = local.regional_condition
      },
      {
        Sid       = "ExactPresetReads"
        Effect    = "Allow"
        Action    = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource  = local.approved_preset_arns
        Condition = local.regional_condition
      },
      {
        Sid       = "AmpMetricRemoteWrite"
        Effect    = "Allow"
        Action    = "aps:RemoteWrite"
        Resource  = local.amp_workspace_arn
        Condition = local.regional_condition
      },
    ]
  })
}

resource "aws_iam_role" "central" {
  name        = "${local.name_prefix}-central"
  description = "ECS container instance and Systems Manager host identity"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "central" {
  name = "${local.name_prefix}-central"
  role = aws_iam_role.central.name
}

# Managed-host baseline for SSM port forwarding and host access only.
resource "aws_iam_role_policy_attachment" "central_ssm_baseline" {
  role       = aws_iam_role.central.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "central_runtime" {
  name = "${local.name_prefix}-runtime"
  role = aws_iam_role.ecs_task["management"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "TaggedSingleDeploymentActivation"
        Effect   = "Allow"
        Action   = "ssm:CreateActivation"
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestedRegion"                 = var.aws_region
            "aws:RequestTag/Project"              = "InfraPulse"
            "aws:RequestTag/Environment"          = var.deployment_id
            "aws:RequestTag/InfraPulseDeployment" = var.deployment_id
            "aws:RequestTag/Owner"                = var.owner
          }
          Null = {
            "aws:RequestTag/ServerId"     = "false"
            "aws:RequestTag/EnrollmentId" = "false"
          }
          StringNotEquals = {
            "aws:RequestTag/ServerId"     = ""
            "aws:RequestTag/EnrollmentId" = ""
          }
          "ForAllValues:StringEquals" = {
            "aws:TagKeys" = [
              "Project", "Environment", "InfraPulseDeployment", "Owner",
              "ServerId", "EnrollmentId",
            ]
          }
        }
      },
      {
        # Native CreateActivation denial identifies the passed role as the
        # dependent tagging authorization target. No managed-node retagging.
        # Request-tag conditions stay on CreateActivation; its dependent
        # role authorization does not carry that request-tag context.
        Sid       = "ActivationTagsOnlyOnPassedHybridRole"
        Effect    = "Allow"
        Action    = "ssm:AddTagsToResource"
        Resource  = aws_iam_role.hybrid.arn
        Condition = local.regional_condition
      },
      {
        Sid      = "PassOnlyHybridRoleToSsm"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.hybrid.arn
        Condition = {
          StringEquals = { "iam:PassedToService" = "ssm.amazonaws.com" }
        }
      },
      {
        # These Actions rows have no resource ARN / ownership condition support.
        # App must paginate and enforce current activation/binding/receipt IDs.
        Sid    = "UnscopableRuntimeRequests"
        Effect = "Allow"
        Action = [
          "ssm:DescribeActivations",
          "ssm:DeleteActivation",
          "ssm:DescribeInstanceInformation",
          "ssm:GetCommandInvocation",
          "ssm:ListCommands",
          "ssm:ListCommandInvocations",
          "ssm:CancelCommand",
        ]
        Resource  = "*"
        Condition = local.regional_condition
      },
      {
        # SendCommand does not support ssm:DocumentVersion in its Actions row.
        # App must pin the real N4 version and validate closed parameters.
        Sid       = "ApprovedCommandDocuments"
        Effect    = "Allow"
        Action    = ["ssm:SendCommand", "ssm:GetDocument", "ssm:DescribeDocument"]
        Resource  = local.approved_document_arns
        Condition = local.regional_condition
      },
      {
        # Cleanup must remain possible after eligibility removal. App/state +
        # native durable decommission marker prevent reinstalling owned nodes.
        Sid       = "OwnedCommandTargets"
        Effect    = "Allow"
        Action    = "ssm:SendCommand"
        Resource  = local.managed_node_arn
        Condition = local.owned_condition
      },
      {
        Sid       = "OwnedNodeInspectionAndCleanup"
        Effect    = "Allow"
        Action    = ["ssm:ListTagsForResource", "ssm:DeregisterManagedInstance"]
        Resource  = local.managed_node_arn
        Condition = local.owned_condition
      },
      {
        # Only eligibility can be changed, never ownership/server/enrollment.
        Sid      = "SetEligibilityOnAlreadyOwnedNode"
        Effect   = "Allow"
        Action   = "ssm:AddTagsToResource"
        Resource = local.managed_node_arn
        Condition = {
          StringEquals = merge(local.owned_condition.StringEquals, {
            "aws:RequestTag/InfraPulseEligibility" = local.eligibility_value
          })
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["InfraPulseEligibility"] }
          Null                        = { "aws:TagKeys" = "false" }
        }
      },
      {
        Sid      = "RemoveEligibilityRetainingOwnership"
        Effect   = "Allow"
        Action   = "ssm:RemoveTagsFromResource"
        Resource = local.managed_node_arn
        Condition = {
          StringEquals                = local.owned_condition.StringEquals
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["InfraPulseEligibility"] }
          Null                        = { "aws:TagKeys" = "false" }
        }
      },
    ]
  })
}

# Attached separately to the two task roles. Classic metric reads have neither
# metric ARN nor namespace condition support; apps must allowlist them.
# Keep the original IAM policy description to avoid replacing the managed policy.
resource "aws_iam_policy" "metric_read" {
  name        = "${local.name_prefix}-metric-read"
  description = "Regional classic CloudWatch metric reads; shared central IMDS caveat applies"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AmpWorkspaceMetricReads"
      Effect = "Allow"
      Action = [
        "aps:QueryMetrics",
        "aps:GetLabels",
        "aps:GetSeries",
        "aps:GetMetricMetadata",
      ]
      Resource  = local.amp_workspace_arn
      Condition = local.regional_condition
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_metric_read" {
  for_each = aws_iam_role.ecs_task

  role       = each.value.name
  policy_arn = aws_iam_policy.metric_read.arn
}
