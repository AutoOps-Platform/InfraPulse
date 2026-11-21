locals {
  ecs_roles = toset(["management", "grafana"])
  ecs_task_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "central_ecs" {
  name = "${local.name_prefix}-ecs-agent"
  role = aws_iam_role.central.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ecs:RegisterContainerInstance", "ecs:DeregisterContainerInstance",
        "ecs:DiscoverPollEndpoint", "ecs:Poll", "ecs:StartTelemetrySession",
        "ecs:SubmitAttachmentStateChanges", "ecs:SubmitContainerStateChange",
        "ecs:SubmitTaskStateChange", "ecs:UpdateContainerInstancesState",
      ]
      Resource  = "*"
      Condition = local.regional_condition
    }]
  })
}

resource "aws_iam_role" "ecs_task" {
  for_each = local.ecs_roles

  name               = "${local.name_prefix}-${each.key}-task"
  assume_role_policy = local.ecs_task_trust
}

resource "aws_cloudwatch_log_group" "ecs" {
  for_each = local.ecs_roles

  name              = "/ecs/${local.name_prefix}/${each.key}"
  retention_in_days = 14
}

resource "aws_iam_role" "ecs_execution" {
  for_each = local.ecs_roles

  name               = "${local.name_prefix}-${each.key}-exec"
  assume_role_policy = local.ecs_task_trust
}

locals {
  ecs_parameter_access = {
    for role in local.ecs_roles : role => concat([
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameters"
        Resource = values(var.ecs_parameter_arns[role])
      },
      ], [for key in lookup(var.ecs_kms_key_arns, role, null)[*] : {
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = key
        Condition = {
          StringEquals = {
            "kms:ViaService"                      = "ssm.${var.aws_region}.amazonaws.com"
            "kms:EncryptionContext:PARAMETER_ARN" = values(var.ecs_parameter_arns[role])
          }
        }
    }])
  }
}

resource "aws_iam_role_policy" "ecs_execution" {
  for_each = local.ecs_roles

  name = "${local.name_prefix}-${each.key}-exec"
  role = aws_iam_role.ecs_execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.ecs_parameter_access[each.key], [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.ecs[each.key].arn}:log-stream:*"
    }])
  })
}
