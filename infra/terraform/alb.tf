locals {
  grafana_alb_enabled    = var.grafana_alb.enabled
  grafana_tunnel_enabled = var.grafana_tunnel.enabled
  grafana_public_https   = local.grafana_alb_enabled || local.grafana_tunnel_enabled
  grafana_effective_issuer = (
    local.grafana_alb_enabled ? "https://${var.grafana_alb.domain_name}/" :
    local.grafana_tunnel_enabled ? "https://${var.grafana_tunnel.domain_name}/" :
    var.ecs_runtime.grafana_issuer
  )
}

resource "aws_security_group" "grafana_alb" {
  count = local.grafana_alb_enabled ? 1 : 0

  name        = "${local.name_prefix}-grafana-alb"
  description = "Public HTTPS/HTTP ingress for the Grafana Application Load Balancer"
  vpc_id      = aws_vpc.lab.id

  ingress {
    description = "HTTP redirect to HTTPS"
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = sort(tolist(var.grafana_alb.ingress_cidrs))
  }

  ingress {
    description = "HTTPS access to Grafana"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = sort(tolist(var.grafana_alb.ingress_cidrs))
  }

  tags = { Name = "${local.name_prefix}-grafana-alb" }
}

resource "aws_vpc_security_group_egress_rule" "grafana_alb_to_central" {
  count = local.grafana_alb_enabled ? 1 : 0

  description                  = "Forward HTTP only to ECS Grafana on the central host"
  security_group_id            = aws_security_group.grafana_alb[0].id
  referenced_security_group_id = aws_security_group.central.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_ingress_rule" "central_from_grafana_alb" {
  count = local.grafana_alb_enabled ? 1 : 0

  description                  = "Grafana HTTP only from the deployment ALB"
  security_group_id            = aws_security_group.central.id
  referenced_security_group_id = aws_security_group.grafana_alb[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_acm_certificate" "grafana" {
  count = local.grafana_alb_enabled ? 1 : 0

  domain_name       = var.grafana_alb.domain_name
  validation_method = "DNS"
  tags              = { Name = "${local.name_prefix}-grafana-cert" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "grafana_acm_validation" {
  for_each = local.grafana_alb_enabled ? {
    for dvo in aws_acm_certificate.grafana[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.grafana_alb.route53_zone_id
}

resource "aws_acm_certificate_validation" "grafana" {
  count = local.grafana_alb_enabled ? 1 : 0

  certificate_arn         = aws_acm_certificate.grafana[0].arn
  validation_record_fqdns = [for record in aws_route53_record.grafana_acm_validation : record.fqdn]
}

resource "aws_lb" "grafana" {
  count = local.grafana_alb_enabled ? 1 : 0

  name                       = "${local.name_prefix}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.grafana_alb[0].id]
  subnets                    = [aws_subnet.central.id, aws_subnet.central_b[0].id]
  drop_invalid_header_fields = true
  idle_timeout               = 60
  tags                       = { Name = "${local.name_prefix}-alb" }

  depends_on = [aws_route_table_association.central_b]
}

resource "aws_lb_target_group" "grafana" {
  count = local.grafana_alb_enabled ? 1 : 0

  name                 = "${local.name_prefix}-grafana"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "instance"
  vpc_id               = aws_vpc.lab.id
  deregistration_delay = 15

  health_check {
    enabled             = true
    path                = "/api/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name_prefix}-grafana" }
}

resource "aws_lb_listener" "grafana_http" {
  count = local.grafana_alb_enabled ? 1 : 0

  load_balancer_arn = aws_lb.grafana[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "grafana_https" {
  count = local.grafana_alb_enabled ? 1 : 0

  load_balancer_arn = aws_lb.grafana[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.grafana[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.grafana[0].arn
  }
}

resource "aws_route53_record" "grafana_alias" {
  count = local.grafana_alb_enabled ? 1 : 0

  zone_id = var.grafana_alb.route53_zone_id
  name    = var.grafana_alb.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.grafana[0].dns_name
    zone_id                = aws_lb.grafana[0].zone_id
    evaluate_target_health = true
  }
}
