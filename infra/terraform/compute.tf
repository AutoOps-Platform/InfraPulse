resource "aws_ecs_cluster" "central" {
  name = "${local.name_prefix}-central"
}

resource "aws_ebs_volume" "grafana" {
  availability_zone = aws_subnet.central.availability_zone
  type              = "gp3"
  size              = 8
  encrypted         = true
  tags              = { Name = "${local.name_prefix}-grafana" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "central" {
  ami                         = var.ecs_ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.central.id
  vpc_security_group_ids      = [aws_security_group.central.id, aws_security_group.database.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.central.name
  monitoring                  = false
  ebs_optimized               = true

  credit_specification {
    cpu_credits = "standard"
  }

  root_block_device {
    # Inherit the AMI snapshot size; the ECS-optimized AL2023 root is 30 GiB.
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
    tags                  = merge(local.ownership_tags, { Name = "${local.name_prefix}-root" })
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    http_protocol_ipv6          = "disabled"
    instance_metadata_tags      = "disabled"
  }

  user_data = templatefile("${path.module}/templates/central-user-data.sh.tftpl", {
    cluster_name   = aws_ecs_cluster.central.name
    grafana_volume = aws_ebs_volume.grafana.id
    aws_region     = var.aws_region
  })
  user_data_replace_on_change = true
  tags                        = { Name = "${local.name_prefix}-central" }

  depends_on = [
    aws_route_table_association.central,
    aws_iam_role_policy_attachment.central_ssm_baseline,
    aws_iam_role_policy.central_ecs,
  ]
}

resource "aws_volume_attachment" "grafana" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.grafana.id
  instance_id = aws_instance.central.id

  # Replacement deletes the old attachment before destroying the old host.
  # Shut down the host before detaching its mounted SQLite filesystem.
  stop_instance_before_detaching = true
}
