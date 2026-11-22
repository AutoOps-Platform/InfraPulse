locals {
  bootstrap_prefix = "bootstrap/"
}

resource "aws_s3_bucket" "bootstrap" {
  bucket        = "infrapulse-${var.deployment_id}-bootstrap-${var.aws_account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "bootstrap" {
  bucket = aws_s3_bucket.bootstrap.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "bootstrap" {
  bucket                  = aws_s3_bucket.bootstrap.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bootstrap" {
  bucket = aws_s3_bucket.bootstrap.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "bootstrap" {
  bucket = aws_s3_bucket.bootstrap.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.bootstrap.arn,
        "${aws_s3_bucket.bootstrap.arn}/*",
      ]
      Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.bootstrap]
}

resource "aws_s3_bucket_lifecycle_configuration" "bootstrap" {
  bucket = aws_s3_bucket.bootstrap.id

  rule {
    id     = "expire-ephemeral-bootstrap-scripts"
    status = "Enabled"

    filter {
      prefix = local.bootstrap_prefix
    }

    expiration {
      days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_iam_role_policy" "management_bootstrap_s3" {
  name = "${local.name_prefix}-bootstrap-s3"
  role = aws_iam_role.ecs_task["management"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "EphemeralBootstrapScripts"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.bootstrap.arn}/${local.bootstrap_prefix}*"
      Condition = {
        StringEquals = {
          "aws:ResourceAccount" = var.aws_account_id
        }
      }
    }]
  })
}
