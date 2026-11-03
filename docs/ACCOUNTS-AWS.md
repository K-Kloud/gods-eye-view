# Accounts and AWS deployment

Open the person icon at the top right of the globe to open the account center.
It adds real layer counts, profile editing, preferences, saved views, security
and data controls alongside the existing globe. With no account configuration,
the local app keeps its previous behavior and explains that cloud sign-in is
not configured. There is no simulated login or local password database.

## Features and boundaries

Cognito managed login handles sign-in, signup when enabled, email confirmation
and forgotten-password recovery. The dashboard implements email changes and
verification, password changes, authenticator (TOTP) setup/verification/disable,
sign-out, global sign-out, account export and deletion through authenticated APIs.

The cloud profile holds display name (also used for avatar initials), organization,
role, country, biography, language, account time zone, voice tier and up to twenty
named views. Saving preferences does not apply them automatically. The explicit
Apply action uses existing language/voice controls; time zone affects dashboard
timestamps only. Voice budgets and other existing controls remain in place.
Views use the existing share hash and reload through existing restoration.

**Existing investigations/evidence remain plaintext browser-local storage.**
Login neither uploads nor encrypts them. Account deletion/sign-out does not remove
them. Manage them in Cyber Defence; account export is not an evidence backup.
Provider keys never enter user profiles. Use separate browser profiles on shared
workstations. No identity attribution or investigation capability is added here.

Authorization code + PKCE, state and nonce use `openid-client`; issuer, audience,
expiry and ID-token signature are checked. Opaque HttpOnly SameSite=Lax cookies
use Secure and `__Host-` under HTTPS. Access tokens are encrypted with AES-256-GCM
in DynamoDB and never exposed in browser storage/API JSON. Writes require CSRF
tokens and the exact configured Origin. User isolation uses the authenticated
subject, never a submitted user ID. Conditional profile writes reject revoked
sessions. Expiry is checked on reads, independently of TTL cleanup.

Sessions last at most one hour, bounded by token expiry. No refresh tokens are
retained. Sensitive changes require sign-in within ten minutes; use Verify your
identity and retry. Global sign-out revokes all Open-i sessions using a shared
epoch and calls Cognito GlobalSignOut. Revocation outside Open-i may take until
the BFF session expires to affect general feed requests. Cognito self-service
APIs validate access tokens on each call. Deletion leaves a minimal revocation
tombstone; expired encrypted sessions use TTL cleanup. AWS backups follow their
configured retention policy.

Production provider APIs require login by default. Authenticated users share
the configured providers; this is not an investigator/admin RBAC system. Local
Provider Settings, desktop Codex OAuth setup, MCP and developer log writing stay
in the existing local workflow. Cloud credentials use Secrets Manager/ECS.
Browser map tokens still need provider restrictions to the app domain.

## Supplied infrastructure

`infra/aws` defines a two-AZ VPC, HTTPS ALB, private ECS Fargate services, two NAT
gateways, Route 53 alias, Cognito Essentials/managed login, on-demand DynamoDB
with encryption/PITR/TTL, session-key secret metadata, CloudWatch and CPU-based
web autoscaling. DynamoDB suits these bounded profiles/sessions without adding
Postgres/Redis baseline capacity. `Dockerfile.production` builds static assets
and runs the existing provider middleware on Node as an unprivileged user. The
development Dockerfile, compose file and Windows launcher are preserved.

One private AIS collector serves vessel snapshots/tracks to all web tasks through
Cloud Map. Replacement stops the old collector first, preventing overlapping
connections for the same AISStream key. Replacement briefly interrupts AIS and
resets in-memory vessel history. Other provider caches remain disposable/per
task, so replicas can multiply upstream polling. Size provider quotas and budgets
accordingly; production load testing is still required.

## Finalize setup

The following steps create billable resources; **none have been deployed by this
change**. Default capacity is two 1-vCPU/2-GB web tasks and one 1-vCPU/2-GB collector,
plus the ALB, two NAT gateways and managed services. Review costs and scaling caps.

1. Choose the AWS account/region, app hostname, Route 53 hosted zone and a validated
   ACM certificate in that region. Configure encrypted remote Terraform state
   with locking/restricted access. Authenticate through AWS SSO/roles; keep static
   AWS access keys out of this repo and container.
2. Build/push `Dockerfile.production` for Linux amd64 into a private ECR repository.
   Use the immutable image digest. Optional build arguments `GOOGLE_MAPS_API_KEY`,
   `CESIUM_ION_TOKEN`, `MAPILLARY_CLIENT_TOKEN` are **browser-visible** tokens, not
   server secrets. The keyless map remains available.
3. Copy `infra/aws/terraform.tfvars.example` to ignored `terraform.tfvars` in that
   directory. Fill in hostname, zone, certificate and image digest. Store provider
   values in Secrets Manager and set only ARN references in `provider_secret_arns`.
   `AISSTREAM_API_KEY` is delivered only to the collector. If using customer-managed
   KMS keys, also grant their decrypt permission to the ECS execution role.
4. Run `terraform -chdir=infra/aws init`, `validate`, and
   `plan -out=deployment.tfplan`. Review before applying that saved plan. The first
   web task will not start until the session secret has a value (next step).
5. Populate output `session_secret_arn` through your trusted secret-management
   workflow with **32 random bytes encoded as base64**. The entire plaintext
   secret value is the base64 text, not JSON. Do not print/commit it. Force a new
   deployment of ECS service `web`. Every web replica must use this same key;
   changing it invalidates sessions. Terraform intentionally does not generate
   this secret value or put it in state.
6. Signup is invitation-only by default. Create the first user in Cognito's Users
   console, or deliberately set `allow_signup = true` in a reviewed apply. Configure
   production SES email delivery and sending quotas for verification/recovery;
   Cognito's default sender is suitable for limited testing. Budget for authenticated
   users' access to shared paid providers before enabling public signup.
7. Verify against real AWS: sign-in/recovery, email change, authenticator enrollment
   and next sign-in, profile/views across devices, expiry, global sign-out and
   deletion. Then verify existing flight/vessel/imagery/voice/cyber flows, inspect
   CloudWatch and load-test within provider quotas before broad release.

Cognito/DynamoDB/ALB deletion protection is enabled, with Terraform prevent_destroy
on identity/profile stores. Teardown needs an explicit backup/protection review.
For CI/CD, use GitHub Actions OIDC and a role scoped to the actual repository and
deployment environment. Run checks, build/push an immutable ECR image, then review
the Terraform plan. No speculative AWS trust role or automatic deployment is
enabled by this change.

## Local configuration and checks

This Windows workspace has a portable Terraform CLI in the parent directory at
`.tools/terraform-1.14.9/terraform.exe`. Invoke it explicitly or add that directory
to PATH before running the Terraform commands above. Continue using the existing
Windows launcher for the local app; `npm start` is the configured production server.

For development with real AWS, use a separate Cognito client/table. Register
callback `http://localhost:4173/api/account/callback` and logout
`http://localhost:4173/`. Set the commented account variables in `.env.example`,
use SSO/role credentials with table permissions, and restart the launcher.
Leave all account variables unset to retain the existing local guest workflow.

Run `npm run test:accounts`, `npm run qa:accounts`, `npm run build`,
`npm run check:boundaries`, `npm run i18n`, and Terraform `fmt -check`/`validate`.
QA uses a disposable browser profile and synthetic identity/storage fixtures;
it does not create real users, call paid AI APIs or touch your browser's cases.
Actual Cognito enrollment/deployment checks remain necessary after provisioning.

Sources: [Cognito managed login](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html),
[authorization and PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html),
[DynamoDB transaction permissions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html),
[ECS autoscaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html).
