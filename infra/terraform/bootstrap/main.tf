# One-time setup applied from a workstation with admin credentials (not by CI):
# the S3 bucket holding Terraform state and the IAM role GitHub Actions assumes
# through OIDC to run infra/terraform. See ../README.md.
terraform {
  required_version = "~> 1.17"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    bucket       = "disc-voice-terraform-state-481116707314"
    key          = "bootstrap/terraform.tfstate"
    region       = "sa-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project   = "disc-voice"
      terraform = "true"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  state_bucket = "disc-voice-terraform-state-${data.aws_caller_identity.current.account_id}"
}

# The bucket is created with the AWS CLI before the first init (the backend
# needs it), then imported here so its settings are managed as code.
import {
  to = aws_s3_bucket.state
  id = "disc-voice-terraform-state-481116707314"
}

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only workflows running on main of this repository.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_subject_prefix}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_terraform" {
  name                 = "disc-voice-github-terraform"
  description          = "Assumed by GitHub Actions (main) to run infra/terraform"
  assume_role_policy   = data.aws_iam_policy_document.github_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_terraform" {
  statement {
    sid       = "Lightsail"
    actions   = ["lightsail:*"]
    resources = ["*"]
  }
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }
  # Only the application stack's state, not the bootstrap state.
  statement {
    sid     = "StateObjects"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      "${aws_s3_bucket.state.arn}/lightsail/terraform.tfstate",
      "${aws_s3_bucket.state.arn}/lightsail/terraform.tfstate.tflock",
    ]
  }
}

resource "aws_iam_role_policy" "github_terraform" {
  name   = "terraform-lightsail"
  role   = aws_iam_role.github_terraform.id
  policy = data.aws_iam_policy_document.github_terraform.json
}

# Read-only role for `terraform plan` on pull requests: it can read Lightsail
# and the state, but cannot change either (plans run with -lock=false).
data "aws_iam_policy_document" "github_plan_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_subject_prefix}:pull_request"]
    }
  }
}

resource "aws_iam_role" "github_terraform_plan" {
  name                 = "disc-voice-github-terraform-plan"
  description          = "Assumed by GitHub Actions on pull requests to run terraform plan (read-only)"
  assume_role_policy   = data.aws_iam_policy_document.github_plan_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_terraform_plan" {
  statement {
    sid       = "LightsailRead"
    actions   = ["lightsail:Get*"]
    resources = ["*"]
  }
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }
  statement {
    sid       = "StateRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/lightsail/terraform.tfstate"]
  }
}

resource "aws_iam_role_policy" "github_terraform_plan" {
  name   = "terraform-plan-read-only"
  role   = aws_iam_role.github_terraform_plan.id
  policy = data.aws_iam_policy_document.github_terraform_plan.json
}

variable "region" {
  type    = string
  default = "sa-east-1"
}

# The repository uses GitHub's immutable OIDC subject (owner and repository IDs
# included), so renaming the repository or owner does not grant access to a
# look-alike. Read it with:
#   gh api repos/gabrielmelogm/disc-voice/actions/oidc/customization/sub
variable "github_subject_prefix" {
  description = "OIDC `sub` prefix of the repository whose workflows may assume the roles"
  type        = string
  default     = "repo:gabrielmelogm@73313748/disc-voice@1461930131"
}

output "github_role_arn" {
  description = "Set as the AWS_ROLE_ARN repository variable"
  value       = aws_iam_role.github_terraform.arn
}

output "github_plan_role_arn" {
  description = "Set as the AWS_PLAN_ROLE_ARN repository variable"
  value       = aws_iam_role.github_terraform_plan.arn
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}
