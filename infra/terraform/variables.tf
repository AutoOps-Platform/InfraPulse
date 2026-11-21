variable "publish_ssm_source" {
  description = "Future explicit publication gate for decoded per-OS release documents/presets; requires separately approved cloud operations, never inferred from source."
  type        = bool
  default     = false
}

variable "association_retirement_confirmed" {
  description = "Explicit operator confirmation, from a separately approved operational plan, that no automatic Configure association remains active. This source neither inspects nor stops AWS associations."
  type        = bool
  default     = false
}

variable "aws_region" {
  description = "The single approved lab region."
  type        = string
  default     = "ap-southeast-1"

  validation {
    condition     = var.aws_region == "ap-southeast-1"
    error_message = "The lab is restricted to ap-southeast-1."
  }
}

variable "aws_account_id" {
  description = "Operator-verified AWS account ID; never discovered implicitly."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must contain exactly 12 digits."
  }
}

variable "deployment_id" {
  description = "Nonsecret unique deployment slug; also the exact eligibility value."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.deployment_id))
    error_message = "deployment_id must be a lowercase 3-32 character slug, starting with a letter and ending with a letter or digit."
  }
}

variable "owner" {
  description = "Nonsecret owner/team contact tag; no tokens or credentials."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,63}$", var.owner))
    error_message = "owner must be a nonsecret 1-64 character team/contact identifier."
  }
}

variable "instance_type" {
  description = "Nitro x86-64 size for the single ECS host."
  type        = string
  default     = "t3a.medium"

  validation {
    condition     = can(regex("^t3a?\\.(small|medium|large|xlarge|2xlarge)$", var.instance_type))
    error_message = "instance_type must be T3 or T3a, from small through 2xlarge."
  }
}

variable "budget_amount_usd" {
  description = "Optional monthly USD alert budget, not a hard cap; requires budget_email."
  type        = number
  default     = null
  nullable    = true

  validation {
    condition     = var.budget_amount_usd == null ? true : var.budget_amount_usd > 0 && var.budget_amount_usd <= 10000
    error_message = "When supplied, budget_amount_usd must be positive and at most 10000 USD."
  }

  validation {
    condition     = (var.budget_amount_usd == null) == (var.budget_email == null)
    error_message = "budget_amount_usd and budget_email must be supplied together or both omitted."
  }
}

variable "budget_email" {
  description = "Optional nonsecret alert contact stored in state; not an authorization or spending cap."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.budget_email == null ? true : length(var.budget_email) <= 254 && can(regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$", var.budget_email))
    error_message = "budget_email must be a valid nonsecret email address when supplied."
  }
}
