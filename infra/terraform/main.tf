# Production host for the API (AWS Lightsail, sa-east-1). These resources were
# created by hand first and are adopted with `import` blocks, so the first apply
# only adds tags: nothing is recreated. Applied by .github/workflows/terraform.yml.
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
    key          = "lightsail/terraform.tfstate"
    region       = "sa-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  # Every taggable resource this stack manages carries terraform = "true".
  default_tags {
    tags = {
      project   = "disc-voice"
      terraform = "true"
    }
  }
}

import {
  to = aws_lightsail_instance.api
  id = "disc-voice-api"
}

import {
  to = aws_lightsail_static_ip.api
  id = "disc-voice-ip"
}

import {
  to = aws_lightsail_static_ip_attachment.api
  id = "disc-voice-ip"
}

# aws_lightsail_instance_public_ports cannot be imported: its first apply
# re-sends the same 22/80/443 rules (PutInstancePublicPorts), a no-op.

resource "aws_lightsail_instance" "api" {
  name              = "disc-voice-api"
  availability_zone = "${var.region}a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = var.bundle_id
  # Created outside Terraform (Lightsail key pairs cannot be imported); the
  # private key stays with the operator.
  key_pair_name   = "disc-voice-key"
  ip_address_type = "dualstack"
  # Docker, swap and /opt/disc-voice. Only runs on first boot.
  user_data = file("${path.module}/user-data.sh")

  lifecycle {
    # Replacing the instance would wipe PostgreSQL and the uploads volume.
    prevent_destroy = true
    # Lightsail does not return user data, so an imported instance would
    # otherwise always plan a replacement.
    ignore_changes = [user_data]
  }
}

resource "aws_lightsail_static_ip" "api" {
  name = "disc-voice-ip"
  lifecycle {
    # The DNS record discvoice.<domain> points at this address.
    prevent_destroy = true
  }
}

resource "aws_lightsail_static_ip_attachment" "api" {
  static_ip_name = aws_lightsail_static_ip.api.name
  instance_name  = aws_lightsail_instance.api.name
}

# SSH, and HTTP/HTTPS for Caddy. PostgreSQL and the API port stay closed.
resource "aws_lightsail_instance_public_ports" "api" {
  instance_name = aws_lightsail_instance.api.name

  port_info {
    protocol   = "tcp"
    from_port  = 22
    to_port    = 22
    cidrs      = ["0.0.0.0/0"]
    ipv6_cidrs = ["::/0"]
  }
  port_info {
    protocol   = "tcp"
    from_port  = 80
    to_port    = 80
    cidrs      = ["0.0.0.0/0"]
    ipv6_cidrs = ["::/0"]
  }
  port_info {
    protocol   = "tcp"
    from_port  = 443
    to_port    = 443
    cidrs      = ["0.0.0.0/0"]
    ipv6_cidrs = ["::/0"]
  }
}

# Files people send in chats (see apps/api/src/storage.rs). A Lightsail bucket
# is an S3 bucket with a fixed price: the 5 GB plan is free for the first 12
# months, then US$ 1/month, with 25 GB of transfer. The API caps each person at
# 1 GB, so the plan can be raised (medium_1_0: 100 GB) once usage grows.
# The bucket stays private: the API signs short-lived links to each file.
resource "aws_lightsail_bucket" "files" {
  name      = "disc-voice-files-481116707314"
  bundle_id = var.files_bundle_id
  lifecycle {
    # Deleting the bucket would delete every file sent in the chats.
    prevent_destroy = true
  }
}

# The API's access key is created outside Terraform, so the secret never lands
# in the state (see README.md, "Arquivos").

variable "region" {
  type    = string
  default = "sa-east-1"
}

variable "bundle_id" {
  description = "Lightsail plan (small_3_1: 2 vCPU, 2 GB, 60 GB). Changing it replaces the instance."
  type        = string
  default     = "small_3_1"
}

variable "files_bundle_id" {
  description = "Lightsail bucket plan (small_1_0: 5 GB, free for 12 months, then US$ 1/month). Can change once per billing cycle."
  type        = string
  default     = "small_1_0"
}

output "files_bucket" {
  value = aws_lightsail_bucket.files.name
}

output "files_bucket_region" {
  value = aws_lightsail_bucket.files.region
}

output "public_ip" {
  value = aws_lightsail_static_ip.api.ip_address
}

output "instance_name" {
  value = aws_lightsail_instance.api.name
}
