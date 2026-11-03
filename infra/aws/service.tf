resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = 30

}
resource "aws_ecs_cluster" "app" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"

  }

}
resource "aws_iam_role" "execution" {

  name = "${local.name}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })

}
resource "aws_iam_role_policy_attachment" "execution" {

  role       = aws_iam_role.execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"

}
resource "aws_iam_role_policy" "secrets" {

  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = concat([aws_secretsmanager_secret.session.arn], [for arn in values(var.provider_secret_arns) : join(":", slice(split(":", arn), 0, 7))])
    }]
  })

}
resource "aws_iam_role" "task" {

  name               = "${local.name}-task"
  assume_role_policy = aws_iam_role.execution.assume_role_policy

}
resource "aws_iam_role_policy" "table" {

  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.accounts.arn
    }]
  })

}
locals {

  services = toset(["web", "ais"])
  account_environment = {

    OPEN_I_APP_ORIGIN        = local.origin
    AWS_REGION               = var.region
    OPEN_I_COGNITO_ISSUER    = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.app.id}"
    OPEN_I_COGNITO_DOMAIN    = "https://${aws_cognito_user_pool_domain.app.domain}.auth.${var.region}.amazoncognito.com"
    OPEN_I_COGNITO_CLIENT_ID = aws_cognito_user_pool_client.app.id
    OPEN_I_ACCOUNT_TABLE     = aws_dynamodb_table.accounts.name
    OPEN_I_REQUIRE_LOGIN     = "true"
    OPEN_I_ALLOW_SIGNUP      = tostring(var.allow_signup)
    OPEN_I_AIS_ORIGIN        = "http://ais.${aws_service_discovery_private_dns_namespace.app.name}:4173"

  }

}
resource "aws_ecs_task_definition" "app" {

  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = each.key == "web" ? aws_iam_role.task.arn : null
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"

  }
  container_definitions = jsonencode([{

    name = each.key, image = var.container_image, essential = true,
    user = "1000:1000",
    portMappings = [{
      containerPort = 4173, protocol = "tcp"
    }],
    environment = [for name, value in merge(each.key == "web" ? local.account_environment : {
      OPEN_I_APP_ORIGIN = local.origin
      }, {
      OPEN_I_ROLE = each.key
      }) : {
      name = name, value = value
    }],
    secrets = concat(each.key == "web" ? [{
      name = "OPEN_I_SESSION_KEY", valueFrom = aws_secretsmanager_secret.session.arn
      }] : [], [for name, arn in var.provider_secret_arns : {
      name = name, valueFrom = arn
    } if(each.key == "ais" ? name == "AISSTREAM_API_KEY" : name != "AISSTREAM_API_KEY")]),
    logConfiguration = {
      logDriver = "awslogs", options = {
        "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = each.key
      }
    },
    healthCheck = {
      command = ["CMD", "node", "-e", "fetch('http://localhost:4173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval = 30, timeout = 5, retries = 3, startPeriod = 30
    }

  }])

}
resource "aws_lb" "app" {

  name                       = local.name
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = true

}
resource "aws_lb_target_group" "web" {

  name        = local.name
  port        = 4173
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.app.id
  health_check {
    path = "/healthz"
  }
  deregistration_delay = 30

}
resource "aws_lb_listener" "https" {

  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn

  }

}
resource "aws_lb_listener" "http" {

  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"

    }

  }

}
resource "aws_route53_record" "app" {

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true

  }

}
resource "aws_service_discovery_private_dns_namespace" "app" {
  name = "${local.name}.internal"
  vpc  = aws_vpc.app.id

}
resource "aws_service_discovery_service" "ais" {

  name = "ais"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.app.id
    dns_records {
      ttl  = 10
      type = "A"

    }
    routing_policy = "MULTIVALUE"

  }
  health_check_custom_config {
  }

}
resource "aws_ecs_service" "web" {

  name                              = "web"
  cluster                           = aws_ecs_cluster.app.id
  task_definition                   = aws_ecs_task_definition.app["web"].arn
  desired_count                     = var.min_web_tasks
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.web.id]

  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 4173

  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true

  }
  lifecycle {
    ignore_changes = [desired_count]
  }
  depends_on = [aws_lb_listener.https, aws_iam_role_policy.secrets, aws_iam_role_policy.table, aws_iam_role_policy_attachment.execution, aws_route_table_association.private]

}
resource "aws_ecs_service" "ais" {

  name            = "ais"
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.app["ais"].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  # Stop the previous collector before replacement: one upstream connection per key.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ais.id]

  }
  service_registries {
    registry_arn = aws_service_discovery_service.ais.arn
  }
  depends_on = [aws_iam_role_policy.secrets, aws_iam_role_policy_attachment.execution, aws_route_table_association.private]

}
resource "aws_appautoscaling_target" "web" {

  max_capacity       = var.max_web_tasks
  min_capacity       = var.min_web_tasks
  resource_id        = "service/${aws_ecs_cluster.app.name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

}
resource "aws_appautoscaling_policy" "cpu" {

  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  target_tracking_scaling_policy_configuration {

    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    scale_in_cooldown  = 180
    scale_out_cooldown = 60

  }

}
