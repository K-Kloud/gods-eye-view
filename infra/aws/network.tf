resource "aws_vpc" "app" {

  cidr_block           = "10.70.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

}
resource "aws_internet_gateway" "app" {
  vpc_id = aws_vpc.app.id
}
resource "aws_subnet" "public" {

  count             = 2
  vpc_id            = aws_vpc.app.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.app.cidr_block, 8, count.index)

}
resource "aws_subnet" "private" {

  count             = 2
  vpc_id            = aws_vpc.app.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.app.cidr_block, 8, count.index + 10)

}
resource "aws_eip" "nat" {
  count  = 2
  domain = "vpc"

}
resource "aws_nat_gateway" "app" {
  count         = 2
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.app]

}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.app.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.app.id

  }

}
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id

}
resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.app.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.app[count.index].id

  }

}
resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id

}
resource "aws_security_group" "alb" {

  name_prefix = "${local.name}-alb-"
  vpc_id      = aws_vpc.app.id
  ingress {
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]

  }
  ingress {
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]

  }
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = [aws_vpc.app.cidr_block]

  }

}
resource "aws_security_group" "web" {

  name_prefix = "${local.name}-web-"
  vpc_id      = aws_vpc.app.id
  ingress {
    protocol        = "tcp"
    from_port       = 4173
    to_port         = 4173
    security_groups = [aws_security_group.alb.id]

  }
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]

  }

}
resource "aws_security_group" "ais" {

  name_prefix = "${local.name}-ais-"
  vpc_id      = aws_vpc.app.id
  ingress {
    protocol        = "tcp"
    from_port       = 4173
    to_port         = 4173
    security_groups = [aws_security_group.web.id]

  }
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]

  }

}
