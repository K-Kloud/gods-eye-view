variable "region" {
  type    = string
  default = "eu-west-1"

}
variable "environment" {
  type    = string
  default = "production"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "Use 2–16 lowercase letters, digits or hyphens."

  }

}
variable "domain_name" {
  type        = string
  description = "Application hostname in the supplied Route 53 zone."

}
variable "route53_zone_id" {
  type = string
}
variable "certificate_arn" {
  type        = string
  description = "Validated ACM certificate covering domain_name in the selected region."

}
variable "container_image" {
  type        = string
  description = "Built Dockerfile.production image in private ECR, preferably pinned by sha256 digest."

}
variable "provider_secret_arns" {
  type = map(string)
  default = {

  }
  description = "ENV_VAR to Secrets Manager ARN, optionally including :json-key::. No plaintext secrets. AISSTREAM_API_KEY is provided only to the collector."

}
variable "min_web_tasks" {
  type    = number
  default = 2
  validation {
    condition     = var.min_web_tasks >= 1 && floor(var.min_web_tasks) == var.min_web_tasks
    error_message = "At least one whole task is required."

  }

}
variable "max_web_tasks" {
  type    = number
  default = 6
  validation {
    condition     = var.max_web_tasks >= var.min_web_tasks && floor(var.max_web_tasks) == var.max_web_tasks
    error_message = "max_web_tasks must be a whole number at least min_web_tasks."

  }

}
variable "allow_signup" {
  type        = bool
  default     = false
  description = "Default is invitation-only; Cognito administrators create users."

}
