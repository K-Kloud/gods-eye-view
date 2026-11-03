output "application_url" {
  value = local.origin
}
output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.app.id
}
output "cognito_client_id" {
  value = aws_cognito_user_pool_client.app.id
}
output "session_secret_arn" {
  value = aws_secretsmanager_secret.session.arn
}
output "account_environment" {
  value = local.account_environment
}
output "cluster_name" {
  value = aws_ecs_cluster.app.name
}
