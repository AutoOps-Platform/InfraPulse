variable "ecs_ami_id" {
  description = "Pinned Amazon ECS-optimized AL2023 x86-64 AMI ID in the lab region; verify the AMI owner and variant before planning."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ami-[0-9a-f]{17}$", var.ecs_ami_id))
    error_message = "ecs_ami_id must be an explicit long-form AMI ID."
  }
}

variable "management_image_digest" {
  description = "Verified Linux amd64 Management image digest with explicit ECS task-credential support."
  type        = string
  nullable    = false

  validation {
    condition = can(regex("^sha256:[0-9a-f]{64}$", var.management_image_digest)) && (
      var.management_image_digest != "sha256:e0ac9bcba9934c4f15f99de61ef5ca95fd6458fa85411b8099052655fe3aca8c"
    )
    error_message = "Use a Management sha256 digest supporting ECS task credentials; the previous Compose digest is incompatible."
  }
}

variable "grafana_image_digest" {
  description = "Verified Linux amd64 Grafana image digest from the existing ECR Public repository."
  type        = string
  default     = "sha256:6320ef9eae33a763ce677b81ccbd1d4c5f80b200227688f7d1df8e841e1ff7f6"
  nullable    = false

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.grafana_image_digest))
    error_message = "grafana_image_digest must be a lowercase sha256 digest."
  }
}

variable "grafana_dashboard_storage_mode" {
  description = "Grafana dashboard S3 Files rollout: disabled, storage provisioned only, or mounted read-only."
  type        = string
  default     = "disabled"
  nullable    = false

  validation {
    condition     = contains(["disabled", "storage", "mounted"], var.grafana_dashboard_storage_mode)
    error_message = "grafana_dashboard_storage_mode must be disabled, storage, or mounted."
  }
}

variable "database_ipv4_cidrs" {
  description = "IPv4 network CIDRs of the existing PostgreSQL endpoints; use /32 for individual addresses."
  type        = set(string)
  nullable    = false

  validation {
    condition = length(var.database_ipv4_cidrs) > 0 && alltrue([
      for cidr in var.database_ipv4_cidrs : try(
        can(cidrnetmask(cidr)) && can(regex("^[0-9.]+/([1-9]|[12][0-9]|3[0-2])$", cidr)) && cidrhost(cidr, 0) == split("/", cidr)[0],
        false,
      )
    ])
    error_message = "Provide at least one canonical IPv4 PostgreSQL CIDR with a /1–/32 prefix; a /0 is forbidden."
  }
}

variable "database_port" {
  description = "TCP port of the existing PostgreSQL endpoint."
  type        = number
  default     = 5432
  nullable    = false

  validation {
    condition     = var.database_port >= 1 && var.database_port <= 65535 && floor(var.database_port) == var.database_port
    error_message = "database_port must be an integer from 1 to 65535."
  }
}

variable "ecs_start_services" {
  description = "Keep true for running deployments. False is for a separately reviewed new target before its ECS connectivity check."
  type        = bool
  default     = true
  nullable    = false
}

variable "ecs_runtime" {
  description = "Nonsecret settings for the Grafana enrollment, Management schema mode and published SSM artifacts."
  type = object({
    grafana_issuer                = string
    grafana_jwks_url              = string
    grafana_org_id                = number
    grafana_namespace             = string
    grafana_auth_methods          = string
    accept_experimental_identity  = bool
    assertion_issuer              = string
    assertion_audience            = string
    assertion_key_id              = string
    grafana_context               = string
    configure_document_version    = optional(string)
    decommission_document_version = optional(string)
    linux_preset_version_id       = optional(string)
    windows_preset_version_id     = optional(string)
  })
  nullable = false

  validation {
    condition = var.ecs_runtime.accept_experimental_identity == true && alltrue([
      for value in [
        var.ecs_runtime.grafana_issuer, var.ecs_runtime.grafana_jwks_url,
        var.ecs_runtime.grafana_namespace, var.ecs_runtime.grafana_auth_methods,
        var.ecs_runtime.assertion_issuer, var.ecs_runtime.assertion_audience,
        var.ecs_runtime.assertion_key_id, var.ecs_runtime.grafana_context,
      ] : try(trimspace(value) != "", false)
      ]) && try(
      var.ecs_runtime.grafana_org_id >= 1 && var.ecs_runtime.grafana_org_id <= 9999999999 && floor(var.ecs_runtime.grafana_org_id) == var.ecs_runtime.grafana_org_id,
      false,
    )
    error_message = "Supply the actual enrollment settings, a positive integer Grafana org ID of at most 10 digits, and explicitly accept the experimental Grafana identity contract."
  }

  validation {
    condition = alltrue([
      for version in [var.ecs_runtime.configure_document_version, var.ecs_runtime.decommission_document_version] :
      version == null || can(regex("^[1-9][0-9]*$", version))
      ]) && alltrue([
      for id in [var.ecs_runtime.linux_preset_version_id, var.ecs_runtime.windows_preset_version_id] :
      id == null || can(regex("^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$", id))
    ])
    error_message = "Omit unknown SSM artifacts; when provided, use published numeric document versions and lowercase UUID preset version IDs."
  }
}

variable "ecs_parameter_arns" {
  description = "Full ARNs of the five existing SSM SecureString parameters, grouped by service and value name. Never pass parameter values."
  type        = map(map(string))
  nullable    = false

  validation {
    condition = toset(keys(var.ecs_parameter_arns)) == local.ecs_roles && alltrue([
      for role, fields in local.ecs_secret_keys : try(
        toset(keys(var.ecs_parameter_arns[role])) == toset(values(fields)) &&
        length(toset(values(var.ecs_parameter_arns[role]))) == length(fields) && alltrue([
          for arn in values(var.ecs_parameter_arns[role]) : can(regex(
            "^arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/infrapulse/${var.deployment_id}/${role}/[A-Za-z0-9_][A-Za-z0-9_.-]*$", arn
          ))
        ]), false
      )
    ])
    error_message = "Provide distinct full same-account, same-region SSM parameter ARNs under /infrapulse/<deployment>/<role>/ without selectors: management (database_url, assertion_trust) and grafana (assertion_key, admin_user, admin_password)."
  }
}

variable "ecs_kms_key_arns" {
  description = "Optional same-region customer-managed KMS key ARNs for each role's SecureString parameters. Omit when using aws/ssm."
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition = alltrue([
      for role, arn in var.ecs_kms_key_arns : contains(["management", "grafana"], role) && can(regex(
        "^arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/([a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$", arn
      ))
    ])
    error_message = "Use same-region, same-account KMS key ARNs (not aliases) keyed by management or grafana."
  }
}

variable "grafana_alb" {
  description = "Optional public Application Load Balancer + ACM TLS + Route 53 DNS in front of ECS Grafana. Mutually exclusive with grafana_tunnel."
  type = object({
    enabled         = bool
    domain_name     = optional(string)
    route53_zone_id = optional(string)
    ingress_cidrs   = optional(set(string), ["0.0.0.0/0"])
  })
  default = {
    enabled = false
  }
  nullable = false

  validation {
    condition = !var.grafana_alb.enabled || (
      try(can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.grafana_alb.domain_name)), false) &&
      try(can(regex("^Z[A-Z0-9]{1,32}$", var.grafana_alb.route53_zone_id)), false) &&
      length(coalesce(var.grafana_alb.ingress_cidrs, [])) > 0 &&
      alltrue([
        for cidr in coalesce(var.grafana_alb.ingress_cidrs, []) : try(can(cidrnetmask(cidr)), false)
      ])
    )
    error_message = "When grafana_alb.enabled is true, supply a lowercase domain_name, a Route 53 zone ID (Z...), and at least one valid IPv4 CIDR in ingress_cidrs."
  }
}

variable "grafana_tunnel" {
  description = "Optional Cloudflare Tunnel sidecar inside the ECS Grafana task for zero-inbound HTTPS access without an ALB. Mutually exclusive with grafana_alb."
  type = object({
    enabled             = bool
    domain_name         = optional(string)
    token_parameter_arn = optional(string)
    image               = optional(string, "cloudflare/cloudflared:2026.11.1@sha256:e613aadbc2d9511785d2e67a86b0c8ac18dd63a3f9af0d06faf04cbfdcb35f2d")
    protocol            = optional(string, "auto")
  })
  default = {
    enabled = false
  }
  nullable = false

  validation {
    condition = !var.grafana_tunnel.enabled || (
      !var.grafana_alb.enabled &&
      try(can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.grafana_tunnel.domain_name)), false) &&
      try(can(regex("^arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/infrapulse/${var.deployment_id}/grafana/[A-Za-z0-9_][A-Za-z0-9_.-]*$", var.grafana_tunnel.token_parameter_arn)), false) &&
      try(trimspace(var.grafana_tunnel.image) != "", false) &&
      try(contains(["auto", "quic", "http2"], var.grafana_tunnel.protocol), false)
    )
    error_message = "When grafana_tunnel.enabled is true, grafana_alb.enabled must be false, domain_name must be a valid lowercase hostname, token_parameter_arn must be a same-account SSM parameter ARN under /infrapulse/<deployment>/grafana/, and protocol must be auto, quic, or http2."
  }
}
