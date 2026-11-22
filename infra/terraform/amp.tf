# Amazon Managed Service for Prometheus (AMP) workspace for InfraPulse host metrics.
# Default 150-day retention; zero fixed workspace fee (usage-based ingestion/storage/query).
resource "aws_prometheus_workspace" "metrics" {
  alias = "${local.name_prefix}-metrics"
  tags  = local.ownership_tags
}

locals {
  amp_workspace_id     = aws_prometheus_workspace.metrics.id
  amp_workspace_arn    = aws_prometheus_workspace.metrics.arn
  amp_endpoint         = "https://aps-workspaces.${var.aws_region}.amazonaws.com/workspaces/${aws_prometheus_workspace.metrics.id}/"
  amp_remote_write_url = "${local.amp_endpoint}api/v1/remote_write"
}
