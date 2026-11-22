resource "aws_vpc" "lab" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_subnet" "central" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.42.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name_prefix}-central" }
}

resource "aws_subnet" "central_b" {
  count = local.grafana_alb_enabled ? 1 : 0

  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.42.2.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name_prefix}-central-b" }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "${local.name_prefix}-igw" }
}

resource "aws_route_table" "central" {
  vpc_id = aws_vpc.lab.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.lab.id
  }

  tags = { Name = "${local.name_prefix}-central" }
}

resource "aws_route_table_association" "central" {
  subnet_id      = aws_subnet.central.id
  route_table_id = aws_route_table.central.id
}

resource "aws_route_table_association" "central_b" {
  count = local.grafana_alb_enabled ? 1 : 0

  subnet_id      = aws_subnet.central_b[0].id
  route_table_id = aws_route_table.central.id
}

resource "aws_security_group" "central" {
  name        = "${local.name_prefix}-central"
  description = "Zero ingress; HTTP/HTTPS outbound for OS packages and AWS services only"
  vpc_id      = aws_vpc.lab.id

  egress {
    description = "Ubuntu package repositories"
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "TLS package downloads and AWS service endpoints"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "egress" {
    for_each = local.grafana_tunnel_enabled ? ["tcp", "udp"] : []
    content {
      description = "Cloudflare Tunnel outbound edge connection (${upper(egress.value)} 7844)"
      protocol    = egress.value
      from_port   = 7844
      to_port     = 7844
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  dynamic "egress" {
    for_each = aws_security_group.grafana_dashboard_mount
    content {
      description     = "NFS only to the private Grafana S3 Files mount target"
      protocol        = "tcp"
      from_port       = 2049
      to_port         = 2049
      security_groups = [egress.value.id]
    }
  }

  tags = { Name = "${local.name_prefix}-central" }
}

resource "aws_security_group" "database" {
  name        = "${local.name_prefix}-database-egress"
  description = "Outbound-only external PostgreSQL access"
  vpc_id      = aws_vpc.lab.id
  ingress     = []

  egress {
    description = "Approved external PostgreSQL destinations"
    protocol    = "tcp"
    from_port   = var.database_port
    to_port     = var.database_port
    cidr_blocks = sort(tolist(var.database_ipv4_cidrs))
  }

  tags = { Name = "${local.name_prefix}-database-egress" }
}
