resource "aws_dynamodb_table" "accounts" {

  name         = "${local.name}-accounts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"

  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true

  }
  server_side_encryption {
    enabled = true
  }
  point_in_time_recovery {
    enabled = true
  }
  deletion_protection_enabled = true
  lifecycle {
    prevent_destroy = true
  }

}
resource "aws_secretsmanager_secret" "session" {

  name                    = "${local.name}/session-key"
  description             = "32 random bytes, base64 encoded. Populate outside Terraform; rotate to invalidate sessions."
  recovery_window_in_days = 30

}
resource "aws_cognito_user_pool" "app" {

  name                     = local.name
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = "ACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"
  software_token_mfa_configuration {
    enabled = true
  }
  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }
  username_configuration {
    case_sensitive = false
  }
  admin_create_user_config {
    allow_admin_create_user_only = !var.allow_signup
  }
  password_policy {

    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true

  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1

    }
  }
  lifecycle {
    prevent_destroy = true
  }

}
resource "aws_cognito_user_pool_domain" "app" {

  domain                = "${local.name}-${data.aws_caller_identity.current.account_id}"
  user_pool_id          = aws_cognito_user_pool.app.id
  managed_login_version = 2

}
resource "aws_cognito_user_pool_client" "app" {

  name                                 = local.name
  user_pool_id                         = aws_cognito_user_pool.app.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile", "aws.cognito.signin.user.admin"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.origin}/api/account/callback"]
  logout_urls                          = ["${local.origin}/"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  access_token_validity                = 1
  id_token_validity                    = 1
  refresh_token_validity               = 1
  read_attributes                      = ["email", "email_verified", "name"]
  write_attributes                     = ["email", "name"]

}
resource "aws_cognito_managed_login_branding" "app" {

  user_pool_id                = aws_cognito_user_pool.app.id
  client_id                   = aws_cognito_user_pool_client.app.id
  use_cognito_provided_values = true

}
