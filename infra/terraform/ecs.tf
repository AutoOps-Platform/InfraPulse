locals {
  ecs_images = {
    management = "${aws_ecrpublic_repository.application["management"].repository_uri}@${var.management_image_digest}"
    grafana    = "${aws_ecrpublic_repository.application["grafana"].repository_uri}@${var.grafana_image_digest}"
  }

  ecs_management_versions = {
    INFRAPULSE_CONFIG_DOCUMENT_VERSION = (
      var.publish_ssm_source ? aws_ssm_document.configure["owned"].document_version : var.ecs_runtime.configure_document_version
    )
    INFRAPULSE_DECOMMISSION_DOCUMENT_VERSION = (
      var.publish_ssm_source ? aws_ssm_document.decommission["owned"].document_version : var.ecs_runtime.decommission_document_version
    )
    INFRAPULSE_LINUX_PRESET_VERSION_ID   = var.ecs_runtime.linux_preset_version_id
    INFRAPULSE_WINDOWS_PRESET_VERSION_ID = var.ecs_runtime.windows_preset_version_id
  }
  ecs_environment = {
    management = merge({
      NODE_ENV                              = "production"
      PORT                                  = "3000"
      MANAGEMENT_DATABASE_URL_FILE          = "/run/secrets/management-db-url"
      MANAGEMENT_ADMIN_TRUST_FILE           = "/run/secrets/assertion-trust"
      MANAGEMENT_GRAFANA_CONTEXT            = var.ecs_runtime.grafana_context
      MANAGEMENT_DB_POOL_MAX                = "4"
      MANAGEMENT_NONCE_MAX_ENTRIES          = "5000"
      AWS_REGION                            = var.aws_region
      INFRAPULSE_AWS_CREDENTIAL_SOURCE      = "ecs-task"
      INFRAPULSE_AWS_ACCOUNT_ID             = var.aws_account_id
      INFRAPULSE_DEPLOYMENT_ID              = var.deployment_id
      INFRAPULSE_OWNER                      = var.owner
      INFRAPULSE_GRAFANA_ORG_ID             = tostring(var.ecs_runtime.grafana_org_id)
      INFRAPULSE_HYBRID_ROLE_NAME           = aws_iam_role.hybrid.name
      INFRAPULSE_ELIGIBILITY_VALUE          = local.eligibility_value
      INFRAPULSE_CONFIG_DOCUMENT_NAME       = local.config_document_name
      INFRAPULSE_DECOMMISSION_DOCUMENT_NAME = local.decommission_document_name
      INFRAPULSE_METRIC_NAMESPACE           = local.metric_namespace
      INFRAPULSE_AMP_WORKSPACE_ID           = local.amp_workspace_id
      INFRAPULSE_AMP_ENDPOINT               = local.amp_endpoint
      INFRAPULSE_BOOTSTRAP_BUCKET           = aws_s3_bucket.bootstrap.id
      INFRAPULSE_BOOTSTRAP_URL_TTL_SECONDS  = "1800"
      }, {
      for name, value in local.ecs_management_versions : name => value if value != null
    })
    grafana = {
      AWS_REGION                                = var.aws_region
      AWS_SDK_LOAD_CONFIG                       = "true"
      INFRAPULSE_AMP_ENDPOINT                   = local.amp_endpoint
      GF_SERVER_ROOT_URL                        = local.grafana_effective_issuer
      GF_SECURITY_COOKIE_SECURE                 = local.grafana_public_https ? "true" : "false"
      GF_DATABASE_TYPE                          = "sqlite3"
      GF_PATHS_PROVISIONING                     = "/etc/infrapulse-aws-provisioning"
      GF_PATHS_PLUGINS                          = "/opt/infrapulse/plugins"
      GF_AWS_ALLOWED_AUTH_PROVIDERS             = "default"
      GF_AWS_ASSUME_ROLE_ENABLED                = "false"
      GF_ANALYTICS_REPORTING_ENABLED            = "false"
      GF_ANALYTICS_CHECK_FOR_UPDATES            = "false"
      GF_PLUGINS_CHECK_FOR_UPDATES              = "false"
      GF_AUTH_ANONYMOUS_ENABLED                 = "false"
      GF_USERS_ALLOW_SIGN_UP                    = "false"
      GF_SECURITY_ADMIN_USER__FILE              = "/run/secrets/grafana-admin-user"
      GF_SECURITY_ADMIN_PASSWORD__FILE          = "/run/secrets/grafana-admin-password"
      GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS = "infrapulse-infrapulse-app,infrapulse-inventory-datasource"
      GF_PLUGINS_FORWARD_HOST_ENV_VARS          = "infrapulse-infrapulse-app"
      INFRAPULSE_IDENTITY_MODE                  = "grafana13-id-token"
      INFRAPULSE_ACCEPT_EXPERIMENTAL_IDENTITY   = tostring(var.ecs_runtime.accept_experimental_identity)
      INFRAPULSE_GRAFANA_ISSUER                 = local.grafana_effective_issuer
      INFRAPULSE_GRAFANA_JWKS_URL               = var.ecs_runtime.grafana_jwks_url
      INFRAPULSE_GRAFANA_ORG_ID                 = tostring(var.ecs_runtime.grafana_org_id)
      INFRAPULSE_GRAFANA_NAMESPACE              = var.ecs_runtime.grafana_namespace
      INFRAPULSE_GRAFANA_AUTH_METHODS           = var.ecs_runtime.grafana_auth_methods
      INFRAPULSE_ALLOW_LOOPBACK_GRAFANA_HTTP    = "true"
      INFRAPULSE_ALLOW_PRIVATE_HTTP             = "true"
      INFRAPULSE_MANAGEMENT_URL                 = "http://${aws_instance.central.private_ip}:3001"
      INFRAPULSE_ASSERTION_ISSUER               = var.ecs_runtime.assertion_issuer
      INFRAPULSE_ASSERTION_AUDIENCE             = var.ecs_runtime.assertion_audience
      INFRAPULSE_ASSERTION_KEY_ID               = var.ecs_runtime.assertion_key_id
      INFRAPULSE_ASSERTION_CONTEXT              = var.ecs_runtime.grafana_context
      INFRAPULSE_ASSERTION_KEY_FILE             = "/run/secrets/assertion-key"
    }
  }
  ecs_application = {
    management = {
      uid          = "10002:10002"
      cpu          = 512
      memory       = 384
      host_port    = 3001
      start_period = 40
      health       = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    }
    grafana = {
      uid          = "472:472"
      cpu          = 1024
      memory       = 896
      host_port    = 3000
      start_period = 60
      health       = ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:3000/api/health"]
    }
  }
  ecs_secret_keys = {
    management = { DATABASE_URL = "database_url", ASSERTION_TRUST = "assertion_trust" }
    grafana    = { ASSERTION_KEY = "assertion_key", ADMIN_USER = "admin_user", ADMIN_PASSWORD = "admin_password" }
  }
  ecs_logs = {
    for role in local.ecs_roles : role => {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ecs[role].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = role
      }
    }
  }
  ecs_secret_mount = { sourceVolume = "task-secrets", containerPath = "/run/secrets" }
  ecs_containers = {
    for role, app in local.ecs_application : role => concat([
      {
        name                   = "secret-init"
        image                  = local.ecs_images[role]
        user                   = "0:0"
        essential              = false
        memory                 = 32
        readonlyRootFilesystem = true
        entryPoint             = ["/bin/sh", "-c"]
        command                = [file("${path.module}/templates/ecs-secret-init.sh"), "secret-init", role]
        secrets = [for name, key in local.ecs_secret_keys[role] : {
          name      = name
          valueFrom = var.ecs_parameter_arns[role][key]
        }]
        mountPoints           = [merge(local.ecs_secret_mount, { readOnly = false })]
        linuxParameters       = { capabilities = { drop = ["ALL"], add = ["CHOWN"] } }
        dockerSecurityOptions = ["no-new-privileges"]
        logConfiguration      = local.ecs_logs[role]
      },
      merge({
        name                   = role
        image                  = local.ecs_images[role]
        user                   = app.uid
        essential              = true
        memory                 = app.memory
        readonlyRootFilesystem = true
        environment            = [for name, value in local.ecs_environment[role] : { name = name, value = value }]
        dependsOn              = [{ containerName = "secret-init", condition = "SUCCESS" }]
        portMappings           = [{ containerPort = 3000, hostPort = app.host_port, protocol = "tcp" }]
        mountPoints = concat([merge(local.ecs_secret_mount, { readOnly = true })], role == "grafana" ? [{
          sourceVolume = "grafana-data", containerPath = "/var/lib/grafana", readOnly = false,
          }] : [], role == "grafana" && local.grafana_dashboard_mount_enabled ? [{
          sourceVolume = "grafana-dashboards", containerPath = "/opt/infrapulse/dashboards", readOnly = true,
        }] : [])
        healthCheck = {
          command     = app.health
          interval    = 30
          timeout     = 3
          retries     = 3
          startPeriod = app.start_period
        }
        linuxParameters = {
          capabilities = { drop = ["ALL"] }
          tmpfs        = [{ containerPath = "/tmp", size = 32, mountOptions = ["rw", "noexec", "nosuid", "nodev"] }]
        }
        dockerSecurityOptions = ["no-new-privileges"]
        logConfiguration      = local.ecs_logs[role]
        }, role == "management" ? {
        command = ["node", "dist/main.js"]
      } : {})
      ], role == "grafana" && local.grafana_tunnel_enabled ? [{
        name                   = "cloudflared"
        image                  = var.grafana_tunnel.image
        user                   = "65532:65532"
        essential              = true
        memory                 = 96
        readonlyRootFilesystem = true
        command = concat(
          ["tunnel", "--no-autoupdate"],
          var.grafana_tunnel.protocol == "auto" ? [] : ["--protocol", var.grafana_tunnel.protocol],
          ["run"],
        )
        secrets = [{
          name      = "TUNNEL_TOKEN"
          valueFrom = var.grafana_tunnel.token_parameter_arn
        }]
        links     = ["grafana"]
        dependsOn = [{ containerName = "grafana", condition = "HEALTHY" }]
        linuxParameters = {
          capabilities = { drop = ["ALL"] }
          tmpfs        = [{ containerPath = "/tmp", size = 16, mountOptions = ["rw", "noexec", "nosuid", "nodev"] }]
        }
        dockerSecurityOptions = ["no-new-privileges"]
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.ecs["grafana"].name
            awslogs-region        = var.aws_region
            awslogs-stream-prefix = "cloudflared"
          }
        }
    }] : [])
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.ecs_roles

  family                   = "${local.name_prefix}-${each.key}"
  network_mode             = "bridge"
  requires_compatibilities = ["EC2"]
  cpu                      = tostring(local.ecs_application[each.key].cpu)
  task_role_arn            = aws_iam_role.ecs_task[each.key].arn
  execution_role_arn       = aws_iam_role.ecs_execution[each.key].arn
  container_definitions    = jsonencode(local.ecs_containers[each.key])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "task-secrets"
    docker_volume_configuration {
      scope  = "task"
      driver = "local"
    }
  }

  dynamic "volume" {
    for_each = each.key == "grafana" ? ["grafana-data"] : []
    content {
      name      = volume.value
      host_path = "/var/lib/infrapulse/grafana-volume/data"
    }
  }

  dynamic "volume" {
    for_each = each.key == "grafana" && local.grafana_dashboard_mount_enabled ? aws_s3files_file_system.grafana_dashboards : []
    content {
      name = "grafana-dashboards"
      s3files_volume_configuration {
        file_system_arn  = volume.value.arn
        access_point_arn = aws_s3files_access_point.grafana_dashboards[volume.key].arn
      }
    }
  }

  depends_on = [
    aws_s3files_mount_target.grafana_dashboards,
    aws_s3files_synchronization_configuration.grafana_dashboards,
    aws_s3files_file_system_policy.grafana_dashboards,
    aws_iam_role_policy.grafana_dashboard_reader,
    aws_vpc_security_group_ingress_rule.grafana_dashboard_nfs,
  ]
}

resource "aws_ecs_service" "service" {
  for_each = local.ecs_roles

  name                               = each.key
  cluster                            = aws_ecs_cluster.central.arn
  task_definition                    = aws_ecs_task_definition.service[each.key].arn
  launch_type                        = "EC2"
  desired_count                      = var.ecs_start_services ? 1 : 0
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = each.key == "grafana" && local.grafana_alb_enabled ? 90 : null

  dynamic "load_balancer" {
    for_each = each.key == "grafana" && local.grafana_alb_enabled ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.grafana[0].arn
      container_name   = "grafana"
      container_port   = 3000
    }
  }

  depends_on = [
    aws_volume_attachment.grafana,
    aws_iam_role_policy.ecs_execution,
    aws_iam_role_policy.central_runtime,
    aws_iam_role_policy.management_bootstrap_s3,
    aws_iam_role_policy_attachment.ecs_metric_read,
    aws_lb_listener.grafana_https,
  ]
}
