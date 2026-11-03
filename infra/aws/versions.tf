terraform {

  required_version = ">= 1.10, < 2.0"
  required_providers {

    aws = {
      source = "hashicorp/aws", version = "~> 6.0"
    }

  }
  # Configure an encrypted remote state backend before a production apply.

}
provider "aws" {

  region = var.region
  default_tags {
    tags = {
      Application = "Open-i", Environment = var.environment
    }
  }

}
data "aws_caller_identity" "current" {

}
data "aws_availability_zones" "available" {
  state = "available"
}
data "aws_partition" "current" {

}
locals {

  name   = "openi-${var.environment}"
  origin = "https://${var.domain_name}"
  azs    = slice(data.aws_availability_zones.available.names, 0, 2)

}
