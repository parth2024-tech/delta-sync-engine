terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

# S3 Bucket for Blocks
resource "aws_s3_bucket" "deltasync_blocks" {
  bucket = "deltasync-blocks-production"
}

# KMS Key for SSE-KMS Encryption (Phase 4 requirement)
resource "aws_kms_key" "s3_key" {
  description             = "KMS key for Deltasync S3 encryption"
  deletion_window_in_days = 10
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deltasync_blocks_encryption" {
  bucket = aws_s3_bucket.deltasync_blocks.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.s3_key.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

# RDS PostgreSQL Database
resource "aws_db_instance" "deltasync_db" {
  identifier           = "deltasync-production-db"
  allocated_storage    = 20
  engine               = "postgres"
  engine_version       = "16"
  instance_class       = "db.t4g.micro"
  username             = "postgres"
  password             = var.db_password # Injected via CI/CD secrets
  skip_final_snapshot  = true
  publicly_accessible  = false
}

# Basic ECS Cluster
resource "aws_ecs_cluster" "deltasync_cluster" {
  name = "deltasync-cluster"
}

variable "db_password" {
  type      = string
  sensitive = true
}
