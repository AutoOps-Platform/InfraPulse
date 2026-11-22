# AWS lab — two application images

## ECS on one EC2 (current deployment)

[Terraform](<../../infra/terraform/>) runs one Management task and one Grafana task as separate EC2-backed ECS services. It uses the existing Singapore lab VPC and public ECR repositories. The default host is one `t3a.medium` with no inbound security-group rules. Grafana listens on host port `3000` for SSM forwarding; Management uses host port `3001`, reachable by Grafana on the same host. Both containers listen on `3000`. No RDS, NAT Gateway, ALB, or Auto Scaling Group is created.

### Inputs and prerequisites

- `ecs_ami_id`: verify and pin an AWS-owned ECS-optimized Amazon Linux 2023 **x86-64** AMI in `ap-southeast-1` (the recommended parameter returned `ami-029bbd3bfe339e72a` on 2026-11-21). Replace the old `ubuntu_ami_id` input. The encrypted gp3 root disk inherits the AMI's size (30 GiB for this AMI). `instance_type` may be omitted for `t3a.medium` or set to a supported T3/T3a size.
- `management_image_digest`: set `"sha256:0814c476b0f441a5bf9f3c049bb4849149edf22c44a265fcf80921daeda2e946"` for the ECS-compatible Management image published and verified on 2026-11-21 (tag `ecs-task-20261121-f0ad5c5ceec84b0da3d89c22af88ca2e` in `public.ecr.aws/h5u5b6t3/infrapulse-lab-20261118-management`). The older Compose digest is incompatible. `grafana_image_digest` defaults to the existing `sha256:6320ef9eae33a763ce677b81ccbd1d4c5f80b200227688f7d1df8e841e1ff7f6`; both images are pulled by digest, not tag. See [ECS inputs](<../../infra/terraform/ecs-variables.tf>).
- `database_ipv4_cidrs`: set the actual PostgreSQL destination CIDRs (prefer `/32` for individual addresses) and optionally `database_port` (default `5432`). The existing database must be reachable from this subnet and allow the EC2's source address. The instance's auto-assigned public IPv4 can change on replacement; if the DB is on a private network, routing must already exist. Keep the existing prepared schema, runtime grants, and TLS contract. Terraform performs no migrations or seed.
- `ecs_runtime`: set the actual `grafana_issuer`, `grafana_jwks_url`, `grafana_org_id`, `grafana_namespace`, `grafana_auth_methods`, `assertion_issuer`, `assertion_audience`, `assertion_key_id` and `grafana_context`; set `accept_experimental_identity = true` only after accepting the current Grafana identity contract. The signing key and trust document must match. The tunnel does not enroll or repair Grafana identity.
- For onboarding, use the real published SSM versions and seeded preset IDs: `configure_document_version`, `decommission_document_version`, `linux_preset_version_id`, `windows_preset_version_id`. Only provide values for capabilities already in place. Terraform uses the managed document versions when `publish_ssm_source` is enabled. Preserve existing SSM publication flags and check the plan for document/preset drift. Do not turn on publication or acknowledge association retirement as part of an ECS rollout unless separately approved; switching off publication on a state that manages protected documents can also block the plan.

Before rollout, create five SSM Parameter Store parameters in the deployment account and region. Use type `SecureString`, tier `Standard` (up to 4096 bytes each), and the default AWS-managed `aws/ssm` key unless a customer-managed key is required. In `ecs_parameter_arns`, supply full ARN references only, without labels or versions. Example ARN map (replace the account and deployment slug):

```hcl
ecs_parameter_arns = {
  management = {
    database_url    = "arn:aws:ssm:ap-southeast-1:123456789012:parameter/infrapulse/lab-example/management/database-url"
    assertion_trust = "arn:aws:ssm:ap-southeast-1:123456789012:parameter/infrapulse/lab-example/management/assertion-trust"
  }
  grafana = {
    assertion_key = "arn:aws:ssm:ap-southeast-1:123456789012:parameter/infrapulse/lab-example/grafana/assertion-key"
    admin_user    = "arn:aws:ssm:ap-southeast-1:123456789012:parameter/infrapulse/lab-example/grafana/admin-user"
    admin_password = "arn:aws:ssm:ap-southeast-1:123456789012:parameter/infrapulse/lab-example/grafana/admin-password"
  }
}
```

Store the complete PostgreSQL **runtime** URL in `database_url`, the trust JSON document itself in `assertion_trust`, and the original PKCS#8 PEM including line breaks in `assertion_key`. `admin_user` and `admin_password` initialize Grafana only on a new SQLite database. If both signing and trust parameters need changing, coordinate their rollout; updating a parameter alone does not change existing tasks.

Each ECS execution role can fetch only its own listed ARNs. If a service's parameters use a customer-managed key, set that key ARN in `ecs_kms_key_arns` for that service and ensure the key policy allows its execution role to decrypt via SSM. Omit this input for `aws/ssm`. Confirm the ECS agent has `ECS_ENABLE_AWSLOGS_EXECUTIONROLE_OVERRIDE=true` as configured by the current host template, and can reach the regional SSM endpoint. See [ECS execution role prerequisites](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html#task-execution-secrets).

Do not supply values to Terraform. ECS injects them only into the initializer, which writes `0400` files on a volume mounted read-only by the application. Host root can still access the container host. Roll out fresh ECS tasks after rotating values. For an existing Secrets Manager deployment, prepare and verify all five parameters before replacing `ecs_secret_arns` with `ecs_parameter_arns`; keep old secrets until the new tasks are healthy and rollback is no longer needed. Rolling back to the prior task definition also requires restoring its prior execution-role policy.

### Access and rollout

Review a full Terraform plan against the existing lab state before any separately approved apply. Expect two one-replica services and one host; **do not** accept deletion of ECR, the Grafana data volume, or the managed SSM artifacts as part of this rollout. After deployment, use SSM Session Manager (AWS CLI, Session Manager plugin, and IAM permission required). From the Terraform root:

```sh
aws ssm start-session --region ap-southeast-1 \
  --target "$(terraform output -raw central_instance_id)" \
  --document-name AWS-StartPortForwardingSession \
  --parameters 'portNumber=3000,localPortNumber=3000'
```

Open `http://127.0.0.1:3000`; verify `/api/health`, one registered ECS container instance and one healthy task per service. If tasks cannot start, check ECS service events and the per-service `/ecs/<deployment-prefix>/<role>` CloudWatch log groups (14-day retention). For a host that never registers, check `infrapulse-ecs-prepare.service` and `ecs.service` through SSM: the scheduler is blocked until the expected EBS volume is mounted. Confirm access to the external DB and intended SSM capabilities separately.

The single host is a single point of failure. Task updates stop the old task before reusing its port, so expect brief downtime. The protected 8 GiB gp3 Grafana volume is separate from the root disk and stays in the same AZ. Back up Grafana before an approved host replacement and schedule downtime: Terraform stops the old host before detaching the mounted data volume, without a force detach. No deployment or live workload verification is represented by these instructions.

### Dashboard storage on ECS (optional)

[Grafana S3 Files](<../../infra/terraform/grafana-s3-files.tf>) supplies dashboard JSON to ECS. The current [Grafana image](<../../deploy/docker/aws-grafana.Dockerfile>) contains the React/Go plugin, Inventory datasource and provisioning YAML, but no dashboard JSON or compiler output. The new image and a populated, readable mount are a single rollout: **do not deploy this image in `disabled` or `storage` mode**. Provisioning can remove existing provisioned dashboards when their source files disappear. Secrets and EBS-backed SQLite remain separate.

Use this sequence only in a separately approved rollout:

1. **`disabled` (Terraform default):** keep the existing Grafana image digest for this phase. Record the running dashboard UIDs and the known-working digest for rollback. Verify the existing EC2 host advertises `storage.s3-files` in ECS and has the compatible S3 Files mount helper installed. If unsupported, stop before mounting; do not change AMI, user-data, or reboot as part of this rollout. See the [ECS S3 Files prerequisites](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/s3files-volumes.html).
2. **`storage`:** keep the existing image digest and provision the private versioned bucket, S3 Files and scoped networking/IAM without changing either ECS task. Review the plan and stop if it proposes replacing EC2 or EBS, changing Management, or deleting existing resources. Publish the canonical dashboard JSON only after approval. Before mounting on the service, verify the mount target is ready and a separately approved read-only diagnostic ECS task on the same host can read the expected JSON via the Grafana task role and access point. Seeing an S3 object alone does not prove it is available through S3 Files.
3. **`mounted`:** in the same reviewed rollout, pin the newly built compatible Grafana image digest and enable the read-only mount at `/opt/infrapulse/dashboards`. Never enable it for an empty or unreadable prefix. Expect a short interruption on this single host; check Grafana health, the VMs plugin and Inventory datasource, and both dashboard UIDs after rollout.

From the repository root, export only the nonsecret dashboard target from the state for the approved deployment. Run the first two commands to inspect the release; the third command is **an AWS write** and requires separate approval. Use Node 24 and an authenticated AWS CLI v2 runner with `s3:PutObject` scoped to the returned bucket and prefix. Verify the printed bucket, account, region and keys before publishing.

```sh
terraform -chdir=infra/terraform output -json grafana_dashboard_publish > grafana-dashboard-target.json
node deploy/scripts/publish-grafana-dashboards.mjs --target grafana-dashboard-target.json
node deploy/scripts/publish-grafana-dashboards.mjs --target grafana-dashboard-target.json --publish
```

The publisher compiles the current release and templates locally. It puts only `fleet.json` and, with the qualified Linux release input, `linux-host.json`, and checks the bucket owner on each request. It never deletes objects or publishes the manifest, dashboard examples, or plugin. If a batch fails, `confirmed` is the count of acknowledged uploads, not a guarantee that the failed request did not write. Check S3 object versions before retrying; there is no automatic rollback.

The new JSON requires a Grafana image containing the VMs app and its `infrapulse-inventory` datasource. Build and verify that image before rollout; the older digest above is not a substitute for this compatibility check. Build directly from the repository root using the [Grafana Dockerfile](<../../deploy/docker/aws-grafana.Dockerfile>); dashboard compilation runs only in the separate publisher workflow. Check that the configured org is the same one served by the CloudWatch datasource and dashboard provider (currently org 1). Inspect existing prefix contents before mounting: the publisher does not remove prior dashboard objects, and Grafana scans any dashboard JSON visible there. If an obsolete object is present, stop and have the operator review separate version-preserving cleanup.

After the one-time mount rollout, publishing revised JSON does not require rebuilding the image, applying Terraform or restarting the task. S3 Files synchronization and Grafana's provider scan are asynchronous. To roll back dashboard contents, restore the intended S3 object version. To roll back the mount, restore the recorded working Grafana digest **and** return to `storage` (not `disabled`) in the same review; reverting only the mount leaves the new image without dashboard files. This retains the bucket, file system and EBS volume. The settings and checks here do not represent a live rollout or a verified mount.

### Build the application images

From the repository root on an external builder, not on the ECS host:

```sh
docker build --platform linux/amd64 -f deploy/docker/aws-grafana.Dockerfile -t infrapulse-grafana:local .
docker build --platform linux/amd64 -f deploy/docker/aws-management.Dockerfile -t infrapulse-management:local .
```

ECS is the only deployment path. Publishing the images and updating the ECS digest pins are separate operator actions. Dashboard JSON is published independently as described above.

### New empty PostgreSQL 18 test database — `push-v1`

**Live rollout gate: the push operator accepts only the local synthetic fixture.** Prisma CLI 7.10.1 passes its datasource URL, including the password, in the schema-engine subprocess arguments even when the CLI receives it through its environment. Do not bypass this guard. The sequence below describes remaining prerequisites, not a cleared procedure for Neon.

The push path is opt-in and was exercised on a disposable PostgreSQL 18 fixture, **not** a live Neon branch. It never migrates, seeds, resets, or runs automatically. Do not use it on an existing Management database, a branch copied with data, or a PostgreSQL major other than 18. The application has no runtime schema-mode switch and does not verify the initialized schema on startup.

1. **Prepare the exact branch.** Confirm the empty test branch/database, PostgreSQL major and *direct* writer endpoint (no Neon `-pooler` host for the operator). Rotate any credential previously shared outside the operator's secret channel. A DBA sets a unique database comment `InfraPulse:push-test:<16–96 letters, digits, underscores or hyphens>` before operator execution. The DBA creates distinct SQL roles: `management_owner` (login, database `CREATE` to create the `management` schema), `management_runtime` (login, no database `CREATE` or ownership), and `management_alert_sync` (can be `NOLOGIN` for this test, no database `CREATE` or ownership). No memberships, elevated attributes, public-schema `CREATE`, or runtime/alert-owned schemas. Keep database ownership with the DBA. On Neon, don't repurpose an elevated Console/API-created role as runtime; if provider defaults conflict with those requirements, stop rather than loosening the checks.
2. **Initialize once, outside ECS — blocked for live use.** Qualify a Prisma engine that never receives credentials in its arguments and ensure it has stopped before releasing the database lock on interruption. Use the reviewed Linux/amd64 Management image with the direct owner URL in a protected, regular UID-10002 `0400`/`0600` file, never in CLI arguments. It must include `schema=management&sslmode=verify-full`; if using `sslrootcert`, mount the verified CA read-only at that absolute path. Verify the exact hostname, port, database name and previously set custody comment, and exclude concurrent schema changes. The fixture operator runs `db push`, applies the companion SQL and marks the schema only after catalog and grants match. A failure after Prisma may leave tables without the marker. **Do not replay**, drop objects, or fill in the marker manually; inspect the confirmed test branch and get approval for a new empty target. An app rollback does not roll back DB DDL.
3. **Verify runtime access separately.** Use `management_runtime`, `schema=management`, `sslmode=verify-full`, and a certificate-valid hostname. Verify TLS, DNS, reconnect and readiness against the actual endpoint from the intended network; a successful direct owner operation does not prove a runtime pooler works. Keep egress limited to verified PostgreSQL destination CIDRs and port. Neon DNS addresses may change; if no sustainable scoped route can be verified, stop rather than adding `0.0.0.0/0`. Store only the runtime URL in its SecureString. The owner URL never goes into Terraform, SSM runtime parameters or ECS.
4. **Review ECS rollout.** Provide the five SecureString ARNs, actual identity inputs and reviewed image digests. Verify the database schema and grants separately; `/health/ready` only checks connectivity. A full, separately approved plan for a **new target only** can use `ecs_start_services = false` for the initial host/network probe with both services at zero replicas; do not apply that setting to running services. Review a second full plan to start services only after network/TLS qualification. Stop on unexpected replacement/deletion, SSM publication drift or missing credentials/identity. Validate Management `/health/ready` through the private path and Grafana `/api/health` through the tunnel, then create/view one approved test VM. Leave unset any unseeded preset IDs: this gives inventory only, not a working installer or alert delivery.

### Legacy DB operations — existing migration-mode databases only

For an explicitly approved migration/seed against an existing legacy-mode deployment, use the matching Management image in a disposable container. Do not use the following commands for the `push-v1` test branch. Set `IMAGE` to that image and `OWNER_DB_URL_FILE` to the absolute path of an owner-only (`10002`, mode `0400`) file containing the existing `management_owner` connection string with `schema=management`. Do not use the runtime-role URL:

```sh
IMAGE=infrapulse-management:local
OWNER_DB_URL_FILE=/absolute/operator/path/owner-db-url

docker run --rm --user 10002:10002 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,src=$OWNER_DB_URL_FILE,dst=/run/secrets/owner-db-url,readonly" \
  -e MANAGEMENT_MIGRATION_DATABASE_URL_FILE=/run/secrets/owner-db-url \
  "$IMAGE" node scripts/migrate-db.ts

docker run --rm --user 10002:10002 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,src=$OWNER_DB_URL_FILE,dst=/run/secrets/owner-db-url,readonly" \
  -e MANAGEMENT_MIGRATION_DATABASE_URL_FILE=/run/secrets/owner-db-url \
  "$IMAGE" node scripts/seed-db.ts
```

These are separate data-changing operator actions, not a startup sequence or commands executed here. The external endpoint must be reachable from the disposable container; use its existing supported connection/TLS settings. Seed emits actual committed preset IDs; use those outputs, never invented IDs.

Keep the existing owner-only `bootstrap-db.ts`, `migrate-db.ts`, `seed-db.ts` and `prepare-owned-db.ts` tools separate from normal API startup. Their existing privilege/path/lab-specific checks are unchanged, not a universal external-Postgres provisioner. This task does not run them or change database data. Alert-sync source and its current host-loopback transport are **unchanged/deferred**; ECS does not automatically reconcile alerts. Existing alert receipts must not be assumed current.

Canonical release/compiler sources remain under [deploy scripts](<../../deploy/scripts/>); only obsolete staged build/cloud/host orchestration is retired. Generated metadata/receipts and historical records remain untouched. No cloud publication/deployment, native qualification or real image/runtime success is inferred from local configuration/tests.

**Everything below is historical, including headings that say “current”, executor commands, three-service manifests and old secret matrices. This section supersedes those deployment instructions; do not run historical command blocks.**

## Historical source and qualification checkpoints

## Current operator boundary (2026-11-19)

This section supersedes earlier checkpoint status/command statements below. Source implementation is not runtime evidence or permission. **No tests, code checks, build, SQL/migration execution, Docker/browser/native/AWS/Terraform/Git/shell, ACL/backup or deployment operation is authorized/performed by this cleanup.** Existing tests/history remain unchanged. Additive retirement 007 and simple-command 008 are UNAPPLIED source, generated Prisma client unchanged by request; not a fresh-DB/grant proof.

The only established cloud action remains the earlier specifically approved foundation saved-plan apply. Central `i-06d77684387158c6d` remains RUNNING, roughly USD22.80/730h base plus variable charges; no hard spending cap. No later image build/publication, app deployment, SSM document/preset/association publication or native OS acceptance is inferred. Source targeting Ubuntu 24.04 amd64 / Windows Server 2022 x64 English is not support qualification; historical VM1/VM2/Telegraf results cannot qualify this AWS path.

### Current source entry and real-input gates

- At this historical checkpoint, the standalone AWS Compose deployment through the staged executor was the default. Those deployment sources are now retired. Default services are management, PostgreSQL and Grafana. No Gateway/Prometheus/Telegraf/current API-key or public profile surface; no resident new InfraPulse agent or central build.
- Only host-loopback Grafana `127.0.0.1:3000` is published, reached with a separately authorized SSM tunnel (`http://localhost:3000`). Central has zero ingress; Management and PostgreSQL have no published port. Do not open a port to bypass a failed gate.
- Main uses validated AWS/identity and the SAME release runtime before listen. Empty release permits central/inventory, not a legacy fallback; malformed present release fails. Each OS independently needs genuine release/artifact/native config/MetricSpec pins, actual published Configure/Cleanup versions and actual committed native-preset DB UUID before bootstrap/retry. The fixed image release directory always contains the SAME decoder even without optional JSON. Do not invent `latest`, version1, digests, UUIDs or another proof authority.
- Current flow is registration-only bootstrap → actual activation/node bind → persisted one Configure Command → separate exact metrics gate. Retry waits for actual prior terminal command; Cleanup shares ownership/lock/fence, then separate operator alert removal precedes deregistration. No current association/qualification triplet/lifecycle engine; retained historical exports are archival and not packaged.
- Task1 Terraform removal does NOT itself stop an old association: explicit operational retirement remains a future gate. Deployment executor refuses the old named automatic association; never re-enable it. Future published SSM document/preset versions must come from actual outputs, not assumed 1.
- Future build stages only derive supported OS bootstrap/dashboard assets, including empty directories, from the same decoder. No DB UUID is baked into immutable images. Owner seed returns actual committed UUIDs and host selectively supplies them to the app/operator runtime; zero/one OS seed is valid. UI null fields display “Chưa xác minh” and cannot be filled from metrics, config or current time.
- Build/deploy executor source is implemented for valid future inputs, with finite operation-specific permission gates. This is not a permanently failing scaffold, an executed release or public-package claim. Build stays on a suitable external builder; public ECR publication or reviewed transfer requires its own explicit authority and actual digests/import identity.
- Deployment stages remain explicit: preflight, create-once secrets, PostgreSQL, fresh-owned-DB prepare, bootstrap, migrate, canonical seed, Grafana initialization, actual enrollment, start, operator alert sync and observation. No implicit chain/migrate/seed, key regeneration or adoption/reset. Future fresh DB must execute full historical migrations then final policy; no history shortcut or rollback/downgrade.
- Current [public inputs/selective protected-file matrix](<management-backend.md>) is authoritative. Runtime Nest gets runtime DB/public assertion trust only; Go gets private Ed25519 key; separate initialization/operator alert-sync gets Admin, never app runtime. Profile SELECT/FKs/history remain for canonical presets; retired runtime legacy grants are revoked only by additive migration after callers are retired.
- Backend and Grafana use default EC2 SDK credentials, not static/home/browser keys. Shared-host IMDSv2 hop2 is not per-container identity isolation. Current user identity remains actual enrolled experimental Grafana ID-token → exact Ed25519 method/raw target/body/nonce → Nest RBAC, no Admin/header fallback. Separate Grafana/internal TLS trust is preserved, not Agent TLS startup.
- Metrics onboarding, independent monitoring and operator alert-sync receipts are separate; CleanupRequired/Decommissioning retain a slot. Never infer Retired from expiration, Unknown from zero, or alert Synced from metric Success.

### Local state and accepted custody

Terraform uses local `infra/terraform/terraform.tfstate` and default local locking, one operator/working directory. No S3 backend, distributed-lock or encryption promise. State/private plans/credentials are not opened, dumped or copied into reports. Existing Windows permissions are accepted; **no additional ACL questions, changes or backup workflow** is introduced. No old lab, host/certificate/volume, cloud resource, apply/deploy/publish/reboot or teardown change is part of E2.

Current rationale and retirement/caller decisions: [architecture](<../architecture/aws-ssm-cloudwatch.md>), [retirement ledger](<../testing/aws/legacy-retirement.md>), [Grafana current flow](<grafana-app.md>), [API](<../contracts/grafana-management-api.md>).

### Preserved I3 operational custody (not executed)

Finite role-specific image/digest stages, public ECR or separately reviewed transfer, owned rerun behavior and backup/compatible rollback remain required. Before ANY existing PostgreSQL mutation, retain exact owned image identity, private mount and network custody checks; labels alone cannot authorize adoption. Runtime Nest receives only runtime DB/public assertion trust, Go only its private signing key, owner bootstrap/migrate/seed only their selected DB files, and alert operator its separate DB/Admin files. No Admin runtime fallback, secret regeneration, automatic stage chain or weakening of checks is part of this simplification.

## Current registry amendment (2026-11-20; source only)

This registry/auth contract supersedes every older GHCR/name/delivery statement below, not the runtime/native/IAM/custody caveats. The current bounded dispatch permits only source edits and Terraform fmt/validate: **no plan/apply, build/push, AWS writes, login/credential reads or host operations have run in this amendment**. Broader requested deployment work waits for independent source review and subsequent gates; no completion is inferred.

[ECR source](<../../infra/terraform/ecr.tf>) defines exactly six new protected repositories through `aws.ecr_public`, `us-east-1`, allowed account `491333778094`, using the existing ownership tags and `prevent_destroy`; force deletion is disabled. Names derive from the pinned `lab-20261118` deployment. The three existing repositories `infrapulse-ingestion-gateway`, `infrapulse-management-backend` and `api-mb-account-name` are unrelated: never import, adopt or change them. The default Singapore provider/resources and SSM publication remain unchanged.

Parent-observed account/registry identity is `491333778094` / `public.ecr.aws/h5u5b6t3`. After separately reviewed non-destructive planning/apply, compare actual `ecr_public_registry`, `ecr_public_repository_urls` and `ecr_public_repository_arns` outputs against AWS before any push; these outputs use resource-returned identities, not fabricated provisioned receipts. No repository existence, digest or effective publisher IAM is established by this source amendment.

| Role | Exact repository; append only `@sha256:<actual digest>` for deployment |
| --- | --- |
| management | `public.ecr.aws/h5u5b6t3/infrapulse-lab-20261118-management` |
| bootstrap | `public.ecr.aws/h5u5b6t3/infrapulse-lab-20261118-bootstrap` |
| migrate | `public.ecr.aws/h5u5b6t3/infrapulse-lab-20261118-migrate` |
| seed | `public.ecr.aws/h5u5b6t3/infrapulse-lab-20261118-seed` |
| alert-sync | `public.ecr.aws/h5u5b6t3/infrapulse-lab-20261118-alert-sync` |
| grafana | `public.ecr.aws/h5u5b6t3/infrapulse-lab-20261118-grafana` |
| postgres | `docker.io/library/postgres` (official upstream, never republished) |

Current public delivery is exactly `{mode:'public-ecr'}`; no GHCR fallback, arbitrary namespace or caller `verified` flag. Reviewed-transfer remains separately authorized and requires actual archive SHA-256, immutable image ID and the same exact RepoDigest identities. The host uses an empty temporary Docker config for anonymous digest pulls; no central registry login or credential forwarding.

Future external-builder publication additionally requires separate secret/context inspection and explicit `--allow-publish --registry-config <protected absolute external config.json>`. The entire config must have only `{"auths":{"public.ecr.aws":{"auth":"<private credential>"}}}`: no credential helpers/store, other registries or extra keys. Never put this config, IAM user keys, login token or registry credentials in the checkout/build context, metadata, argv or logs. Source does not perform login. An independently authorized operator must use AWS CLI **`ecr-public get-login-password --region us-east-1`** piped directly to **`docker --config <isolated external directory> login --username AWS --password-stdin public.ecr.aws`**, with tracing disabled and no token logging; never use Singapore `ecr` login. Inspect config shape without printing credentials, explicitly hand the protected config to the builder, and dispose of temporary auth after use. IAM/token authenticity/expiry and actual public digest availability remain runtime gates, not source claims.

## HISTORICAL / chronological I2–I3–N4–G4 source checkpoints

All remaining text is retained checkpoint history, including superseded scaffold restrictions, command examples, ACL/backup instructions and old status matrices. **Those command blocks are not current instructions or execution approval.** Where checkpoints conflict, the current boundary and linked current interfaces above win. The I3 dependency-unblocked section records source capabilities only, not deployed/qualified results.

## Status and configuration assertions

I2 defines configuration, not an existing AWS lab. Native qualification, effective
IAM, account/AMI/pricing checks, deployment, publish and reboot are **NOT RUN**.
No `artifacts.lock.json` or `contracts.v1.json` is supplied by this task. The I1
pure validator is not native evidence. Controller spec + quality review is still
required. No existing lab is migrated or changed.

Expected future reviewed plan (assertions, not a saved plan or live inventory):

- Exactly one VPC, public subnet, internet gateway, route table and IPv4 default
  route; Singapore `ap-southeast-1` only. No NAT, ALB, RDS, EKS, Redis or Kafka.
- One central Ubuntu 24.04 amd64 EC2 `t3a.small`, Standard credits, detailed
  monitoring off, explicit pinned operator-supplied AMI, no latest AMI lookup.
- One SG with **empty ingress**, no SSH key, no public ports 22/3000/3001/5432.
  Public IPv4 is for outbound package/SSM connectivity, not an inbound service.
  SG egress is TCP 80/443 only, not a domain/endpoint allowlist; VPC DNS/time
  services retain AWS platform behavior. AWS-created default SG is not attached.
- One encrypted gp3 root volume, 20 GiB, **delete_on_termination = true**; no extra
  data volume. App/Docker state on that root is not durable across replacement.
  User-data changes request replacement: separately review backups and recreation.
- IMDS endpoint enabled, **tokens required**, response hop limit **2**, metadata
  tags disabled. Hop 2 permits container access and is not workload isolation.
- Central uses an EC2 instance profile, never a hybrid activation or inventory
  Server. It has ownership tags but **no eligibility tag**.
- All Terraform resources that support tags carry Project=InfraPulse,
  Environment=<deployment_id>, InfraPulseDeployment=<deployment_id>, Owner=<owner>.
  Runtime nodes gain these ownership tags through activation, not arbitrary retagging.
- User data contains only nonsecret OS/Docker/SSM bootstrap, 2 GiB swap, bounded
  Docker/journal logging. No app images/config, passwords, activation, static AWS
  keys, registry token, native hybrid artifacts or automatic reboot. Apt/snap
  versions on central are not qualified hybrid artifact/version receipts.
- Optional monthly USD COST budget has actual 80% and forecast 100% email alerts.
  It deliberately observes **account-wide** spend (including unrelated resources),
  avoiding dependence on unactivated cost-allocation tags. It is **not a hard
  spending cap**, an auto-stop or permission to create resources.

## Inputs, naming and outputs

Required nonsecret inputs: verified 12-digit `aws_account_id`, safe lowercase
3–32 character `deployment_id`, nonsecret `owner`, and explicit `ubuntu_ami_id`.
`aws_region` is fixed to Singapore; `instance_type` cannot exceed/change baseline.
AMI syntax validation cannot prove Ubuntu release, architecture, owner or safety:
operator must verify these, region and pricing before any cloud permission.
Optional `budget_amount_usd` and `budget_email` must be supplied together. Budget
email is nonsecret contact data retained in state; do not put credentials in it.

Names are reserved, **not provisioned** by I2:

- `InfraPulse-<deployment_id>-Configure`
- `InfraPulse-<deployment_id>-Decommission`
- `/infrapulse/<deployment_id>/presets/linux`
- `/infrapulse/<deployment_id>/presets/windows`
- Dedicated eligibility: `InfraPulseEligibility=<deployment_id>`.

The `deployment_environment` nonsecret output maps AWS_REGION,
INFRAPULSE_AWS_ACCOUNT_ID, INFRAPULSE_DEPLOYMENT_ID, INFRAPULSE_HYBRID_ROLE_NAME,
INFRAPULSE_ELIGIBILITY_VALUE, INFRAPULSE_CONFIG_DOCUMENT_NAME,
INFRAPULSE_DECOMMISSION_DOCUMENT_NAME, INFRAPULSE_LINUX_PRESET_NAME,
INFRAPULSE_WINDOWS_PRESET_NAME and INFRAPULSE_METRIC_NAMESPACE (`InfraPulse/Lab`).
The four `*_VERSION` entries are deliberately **absent**, not `1`, `$LATEST`, null
receipts or fabricated qualification. N4 must provision actual documents/presets
and supply reviewed immutable versions through the protected deployment environment.
Startup must remain fail-closed until that full contract exists. Separate outputs
expose central instance, subnet, SG and VPC IDs, namespace, hybrid role and eligibility.
`native_qualification_status` remains NOT RUN. No public IP or secrets are outputs.

N4 owns the actual static association, versioned documents and parameters, gated
by native qualification. Association targeting must be the **single exact**
eligibility tag above, not `*` or an assumed AND of several tags. Reserved IAM
association ARNs are constrained to this account/region and ownership resource tags;
there is no invented association ID or version. Runtime cannot create associations.

## Offline Terraform CLI exception

Precondition before implementation: empty Terraform root (zero `.tf` files).
`terraform -chdir=infra/terraform fmt -check -recursive` can exit 0 on that empty
root; this is **not RED** and cannot establish any infrastructure requirement.
Use the assertions above plus configuration/policy review, not fake syntax errors
or prohibited tests/README files under infra.

Binding I2 constraints: Terraform `>= 1.10, < 2.0`, AWS provider `~> 6.0`.
Actual CLI and selected provider/checksums are recorded in the toolchain inventory
and generated lockfile; do not auto-upgrade. The generated lock is part of the
reviewed change, but is not staged or committed by the implementer.

From repository root, offline-authorized commands only:

```text
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -reconfigure -input=false -lockfile=readonly -no-color
terraform -chdir=infra/terraform validate -no-color
```

The direct user choice amends I2 to an explicit **local backend**, not S3.
Before this initial local init, check existence/metadata only for
`infra/terraform/terraform.tfstate`, `infra/terraform/terraform.tfstate.backup`
and `infra/terraform/.terraform/terraform.tfstate`. If any state or previous
initialized-backend metadata exists unexpectedly, stop for reviewed recovery;
never migrate, adopt, reset, delete or overwrite it automatically. `-reconfigure`
here is authorized only for the checked state-absent initial local configuration,
not as a general recovery command. No migration flags or `-lock=false`.

Initialization writes workspace-local `.terraform/` backend metadata and reuses
available provider dependencies; the existing `.terraform.lock.hcl` must stay
byte-for-byte unchanged (`-lockfile=readonly`), without `-upgrade`. Use an empty
CLI configuration, no global plugin cache, no inherited CLI argument injection,
no remote backend and no AWS credential/account lookup. Do not disable provider
signatures/checksums. Only the actual `windows_amd64` operator platform is locally
validated; other operator platforms must obtain official lock checksums and
validation under separate authorization before use. A registry signature is
provider authenticity, not an effective-IAM or native feature test.

### Local state custody — one operator, one working directory

`backend.tf` sets `path = "terraform.tfstate"`, relative to the Terraform working
directory `infra/terraform`: state is `infra/terraform/terraform.tfstate`, with
local backup `infra/terraform/terraform.tfstate.backup`. Default local locking
remains enabled; lock info is `infra/terraform/.terraform.tfstate.lock.info`.
Use one operator and this one working directory; no concurrent or shared apply,
shared state directory or alternate workspace/state copies for the same lab.
Any future plan/apply still requires separate explicit permission and review.

Treat state, backups, lock info, backend metadata, private tfvars and saved plans
as sensitive: no Git, reports, console dumps, chat, public artifacts or uploads.
Root ignore rules `.terraform/` and `*.tfstate*` cover metadata, state, backup and
lock info; verify with `git check-ignore --no-index`. Git ignore is **not encryption
or backup**. The local backend provides no encryption, versioning or distributed
locking. Restrict filesystem/Windows ACL access to the operator; use protected
encrypted local storage and operator-managed protected local backups outside the
checkout, with retained known-good copies and a reviewed recovery procedure.
The adjacent `.backup` alone is not protection against disk/worktree loss.
Loss of state is significant: it loses Terraform's resource bindings and can
lead to duplicate or unsafe resource operations. Stop on missing/unexpected state
for an existing lab; do not recreate, import, adopt or overwrite automatically.
No backup upload, S3 bucket creation or cloud backup call is authorized here.

## IAM action/resource/condition checklist

This is an action allowlist review, **not** an IAM simulator/effective-policy claim.
All regional allow statements use `aws:RequestedRegion=ap-southeast-1`; PassRole
uses exact role ARN and `iam:PassedToService=ssm.amazonaws.com`. Ownership checks
use Project, Environment and InfraPulseDeployment tags. Owner is contact metadata.
Tag-based scope is deployment-level, **not per-node credential isolation**.

### Operator / Terraform (not granted by runtime)

Operator keeps local Terraform state and protected local backups under the
custody rules above; no state bucket, S3/DynamoDB backend permission or cloud
backup is required or created. This root does not grant operator IAM. Operator
needs reviewed EC2/network/IAM/budget and later SSM document/parameter/association
provisioning permissions, fixed role passing, protected local-file access and
tunnel access. Runtime has no
Terraform, backend, document mutation, IAM mutation, parameter write or
StartSession privilege. Operator tunnel permission should target central and the
approved port-forwarding document; only the separately authorized operator starts
it. Grafana baseline remains `http://localhost:3000`, with zero ingress.

### Hybrid node role

- Trust: SSM service only, exact SourceAccount, SourceArn restricted to this
  account's regional SSM service resources (confused-deputy mitigation).
- `DescribeAssociation`, `UpdateInstanceAssociationStatus`: regional account
  association ARNs with ownership tags (and managed-node target where applicable).
- `GetDocument`, `DescribeDocument`, `UpdateAssociationStatus`: only the two
  reserved document ARNs; managed-node status targets remain deployment-owned.
- `ListInstanceAssociations`, `UpdateInstanceInformation`: deployment-owned
  `managed-instance/mi-*` only. No EC2 inventory node registration.
- `ListAssociations` requires `Resource:*` in the AWS Actions table. Agent uses
  it to receive assignments; this is not broad DescribeInstanceInformation or
  node-driven identity discovery. Exact document/local manifest checks remain
  mandatory; no node ListTags/AddTags/RemoveTags/eligibility writes.
- `ssmmessages:CreateControlChannel/CreateDataChannel/OpenControlChannel` use
  `Resource:*` (no resource ARN scope in those Actions rows). `OpenDataChannel`
  instead uses this account/region's `ssm:session/*` ARN scope. Its supported
  session-id/target-id tag conditions are not a proven hybrid binding fence;
  no per-node session isolation is claimed. Only this modern SSM messaging path
  is included; N4/I4 must qualify agent/version/refresh functionality. No legacy
  ec2messages, patching, inventory, package reporting or optional log permissions
  are preemptively granted to hybrid nodes.
- `ssm:GetParameter/GetParameters` only the two **exact** preset parameter ARNs;
  no path wildcard, GetParametersByPath, secret/KMS/log access. The renderer must
  request the actual qualified version, validate hash and local identity.
- Classic `cloudwatch:PutMetricData` requires `Resource:*` and exact
  `cloudwatch:namespace=InfraPulse/Lab`. There is no per-metric ARN/dimension IAM
  isolation: a compromised node can forge another node's dimensions within that
  namespace. Binding, receipt, qualified dimensions and timestamps are app checks.

### Central runtime (separate from central's agent baseline)

- `CreateActivation` uses `Resource:*` (no activation ARN support), exact required
  ownership/eligibility request tags, nonempty ServerId/EnrollmentId, and closed
  `aws:TagKeys`. App requires UUIDs, registration limit 1, TTL 60 minutes,
  maxAttempts 1, durable intent/idempotency, and ambiguity reconciliation.
- `DescribeActivations`, `DeleteActivation`, `DescribeInstanceInformation`,
  `GetCommandInvocation`, `ListCommands`, `CancelCommand`, `ListAssociations`
  require `Resource:*`: those rows do not support ARN scope or ownership conditions.
  App must paginate bounded queries, filter by exact activation IDs/current
  binding/deployment, verify ownership and receipts before every mutation/read,
  and never cancel/delete arbitrary commands/activations. IAM does not enforce
  pagination, maximum node count, TTL or command ownership for these APIs.
- **Unproven dependent authorization gate:** AWS maps CreateActivation to
  AddTagsToResource and PassRole too. No wildcard AddTags or initial ownership
  retag grant is supplied to make that dependency appear to work. The only direct
  AddTags grant below is owned-node eligibility mutation. I4 must establish that
  activation tagging works with this narrow policy or bring a supported IAM
  context/design change for review. **CreateActivation-with-tags authorization
  may fail; activation creation is not claimed usable.** A failing gate needs a
  reviewed security-sensitive redesign, not automatic permission widening.
  Activation tags are inherited by future nodes; existing activation tags cannot
  be mutated using AddTagsToResource. RegistrationMetadata is AWS-internal only,
  not app correlation storage; later correlation must use safe Description or
  DefaultInstanceName and durable receipts.
- `iam:PassRole`: one fixed hybrid ARN, SSM service only; no role enumeration,
  attach/update/create/delete IAM, AssumeRole or arbitrary role input.
- `SendCommand`: exact two reserved document ARNs, and account/regional owned
  `managed-instance/mi-*` targets; no AWS-RunShellScript/RunPowerShellScript,
  instance targets, wildcard document names, output S3 buckets or arbitrary shell.
  The SendCommand Actions row has **no `ssm:DocumentVersion` condition**. App must
  enforce the qualified version, parameter allowlist, exact node binding and
  current lifecycle state; IAM alone cannot pin a document version or distinguish
  config from cleanup eligibility. Decommission marker/shared lock prevents queued
  reinstallation. No document mutation permissions are granted.
- `DescribeAssociation/DescribeAssociationExecutions/DescribeAssociationExecutionTargets/StartAssociationsOnce`
  and association tag reads: account/regional association ARNs + ownership tags.
  Runtime cannot create/update/delete associations or change their targeting.
- `AddTagsToResource/RemoveTagsFromResource`: only owned `mi-*`, only
  InfraPulseEligibility key; adding requires exact deployment value, removing
  retains Project/Environment/InfraPulseDeployment/Owner/ServerId/EnrollmentId.
  `ListTagsForResource` and `DeregisterManagedInstance` target owned nodes only.
  App independently checks current binding and cleanup receipt; no deregister
  before cleanup. Eligibility absence does not revoke already queued commands.

### Central own SSM baseline and Grafana readback

Central alone attaches AWS-managed `AmazonSSMManagedInstanceCore` separately. This
is the host-agent trust boundary: broad SSM core document/parameter reads, inventory,
compliance, ssmmessages and ec2messages in that AWS policy are **not** hybrid runtime
permissions. The policy can change upstream and can let any process with central
credentials read more parameters/documents than the runtime subset. No secret
parameters/admin secret should be exposed to that identity. Review the actual
managed policy again before any cloud use; Terraform validation cannot freeze it.

The dedicated metric-read policy attached to the same central instance role is
explicitly for backend verification + Grafana: `GetMetricData`,
`GetMetricStatistics`, `ListMetrics`, classic metrics `Resource:*`, region-only.
These Actions rows do **not** support `cloudwatch:namespace`; do not attach that
condition or claim namespace/read isolation. Backend and Grafana configuration
must independently allowlist namespace and qualified dimensions; the IAM role can
read other classic metrics in this account/region. OTLP/dataset ARNs are not a
substitute for classic metric scoping.

**Shared-host IMDS caveat:** separate policies/code paths do not isolate containers.
Both can use the instance profile; Grafana compromise can exercise backend writes
and baseline SSM rights. This lab explicitly accepts a host trust boundary, not a
read-only Grafana security boundary. A real workload identity/compute split would
need a separately reviewed design. Protected Grafana Admin secret stays outside
app access; operator-only alert sync is not implemented by Terraform here.

## Real cloud / native gate — NOT RUN

The local-only initialization above is authorized configuration work, not a
cloud gate. No S3/DynamoDB state backend, bucket bootstrap, credentials or remote
state migration is part of the current design. Before any separately authorized
cloud operation, verify account/region/deployment/ownership, pinned AMI, pricing,
provider lock/platform, permissions, cost contacts and protected local state/
backup custody. Do not use shared/concurrent apply, private tfvars/state/plan
output in reports, or static keys in app/Compose/user data. Application uses the
default EC2 credential chain only.

Any saved plan and subsequent apply require separate explicit authorization and
independent review; no auto-approve, plan/apply/destroy executed by I2. Review
replacement/delete behavior before acting. After authorized provisioning capture
only sanitized IDs/SG rules/IMDS settings/SSM Online and cost inventory, verify no
inbound 3000/3001/5432, then retain this evidence outside infra. Never dump state,
instance credentials, activation material or raw command output. Real IAM negative
and lifecycle tests are I4; real document/preset versions are N4; neither is proven
by CLI validate. No native install, app/seed deploy, publish or reboot is implicit.
Whole-lab teardown requires hybrid cleanup and volume/ownership review under its
own permission; this task does not destroy anything.

## I3 dependency-unblocked SOURCE completion — UNVERIFIED

This section supersedes the historical I3 scaffold/executor/mount statements below.
It grants **no execution permission**. No tests, build, compiler, CLI check/execute,
package install, Docker, SQL, native, AWS, Terraform, Git, ACL or backup operation
was run for this completion. N1–N4/G1–G4 source acceptance is not actual I4 evidence.
All eight accepted migrations remain immutable; no schema or SDK-port change.

### Finite source interfaces (future explicit permission only)

- [Build entry](../../deploy/scripts/build-aws-images.mjs) has a local-read/pure-compiler
  `--check` branch with no child-process import, network, writes or secret reads.
  Missing genuine canonical inputs still fail; valid inputs are not hard-coded failures.
- Its [executor](../../deploy/scripts/aws-build-executor.mjs) requires `--execute`,
  `--builder local --allow-build --allow-pull --release-id <16–64 lowercase hex>`.
  It refuses SSM/central/remote Docker contexts and requires a Linux amd64 builder
  with at least 4 GiB. A fresh minimal context excludes secrets/env/state/tests and
  generated checkout assets; source bytes are hashed and labeled per exact role.
  Frozen image stages call actual canonical N1/G3 compilers, not cached fake outputs.
  Plugins/provisioning remain image-owned outside persistent Grafana data.
- There is **no publication by default**. `--allow-publish` additionally requires
  `--registry-config <explicit protected external file>` containing only GHCR auth.
  No login, registry creation, ECR assumption, credential fallback or `latest` tag.
  Actual local image IDs / actual published RepoDigests are returned, never fabricated.
- [Deployment entry](../../deploy/scripts/deploy-aws.mjs) also keeps `--check` pure.
  Future `--execute` requires `--instance-id`, `--deployment-id`, `--account-id`,
  `--profile default`, `--step <step>`, `--allow-cloud-read --allow-ssm`, and
  `--allow-host-step <same step>`. The sole target is account `491333778094`,
  `i-06d77684387158c6d`, `lab-20261118`, Singapore, owner `caophi562005`.
  No old VM discovery/adoption, new resource/permission, build or publication follows.
- [Cloud executor](../../deploy/scripts/aws-deploy-executor.mjs) verifies actual STS,
  exact EC2 IDs/tags/network/zero ingress/IMDS settings, SSM Online and current N4
  document/preset/association bodies/versions against accepted canonical compilers.
  Online is not tools or app readiness. AWS-RunShellScript is separately reviewed,
  version/hash pinned and used only with explicit operator authority; central runtime
  IAM does not grant that transport. Finite invocation polling never blindly redispatches.
- [Ephemeral host source](../../deploy/scripts/aws-host-runtime.sh) observes actual
  Ubuntu/target/tools/Compose v2/headroom before owned path initialization. docker.io
  alone is insufficient: missing Compose is a clear owned-setup prerequisite, not
  an installation or forged receipt. Fresh empty paths permit first ownership markers;
  foreign/nonempty/unmarked paths refuse. No resident host agent or background job.

### Public inputs, staged identity and custody

Only fixed bounded public inputs are read. Reviewed base pins remain exactly
`node`, `go`, `grafana`, `postgres`. Release metadata retains the seven exact image
roles/repositories below, and adds `sourceSha256`, `enrollment`, `hostDocument`.
`hostDocument` is exactly `{version,canonicalSha256}` for the actual reviewed
AWS-owned AWS-RunShellScript version/body; no fabricated version is supplied.
Ownership includes `Owner`. Environment requires all published N4 versions and
association ID/current version plus actual N1 bundle hash; seed UUIDs/org ID may
be omitted initially and are supplied only from committed/observed protected output.
`enrollment:null` permits brand-new initialization; later reviewed enrollment is
`{issuer,jwksUrl,orgId,namespace,authMethods,acceptExperimentalIdentity}` and is
checked against actual Grafana org/settings/JWKS before protected enrollment.
No token claims, org ID, preset UUID, digest or SSM version is guessed.

A separate small public `deploy/generated/aws-target.json` must contain exactly
`format:"infrapulse-reviewed-target-v1"`, `centralInstanceId`, `vpcId`, `subnetId`,
`securityGroupId`, `environment`, extracted/reviewed from actual nonsecret outputs.
The executor never opens raw state/private plans or invokes Terraform.
Public GHCR delivery anonymously pulls exact digests and inspects actual bytes/labels.
Reviewed-transfer archive records additionally require actual `imageId`; operator
transport to the exact owned host delivery directory needs separate authority.
Host verifies actual archive bytes, imported image ID/RepoDigest and source/owner
labels. Importers that cannot preserve the digest must stop, never retag/fallback.

Explicit single stages are: `preflight`, `init-secrets`, `postgres`, `prepare`,
`bootstrap`, `migrate`, `seed`, `grafana-init`, `enroll`, `start`, `sync-alerts`,
`observe`, `backup`, `rollback-app`. No automatic stage chain or startup migration.
`prepare` only marks a proven fresh owned dedicated DB, denies its PUBLIC
CONNECT/TEMP/schema CREATE, and refuses foreign/nonempty DBs; bootstrap then grants
only dedicated role CONNECT. Existing role/password/object refusal checks remain.
Owner-only seed returns bounded genuine committed published preset UUID/hash/body
identity; protected host pins feed the SAME G4 `createQualifiedRuntime` at main →
bootstrap → AppModule. One `runtime.aws` useValue serves verifier/HTTP/retry/cleanup
and one existing reconciler/raw budget. Missing genuine inputs fail before listen.

Secrets are created once atomically outside checkout, UID-selective `0600` files;
reruns preserve complete sets and refuse partial rotation. Runtime Nest receives
runtime DB + public assertion trust ONLY; bootstrap gets four DB URLs; migrate/seed
owner ONLY; Go gets Ed25519 private key ONLY; alert job gets alert DB + closed Admin
ONLY. Initial Grafana operator server disables plugins/provisioning and uses separate
init-only user/password files, then is stopped/removed at enrolled handoff (explicit
`--allow-app-stop`); normal Grafana/app receives no Admin. Its owned SQLite/user may
initialize before enrollment, and an owned stopped initializer can resume.
Every alert invocation resolves the exact labeled PostgreSQL network endpoint anew.
`observe` requires a genuine protected non-Admin user session, actual ID-token/assertion
bridge, SDK health and container-network IMDSv2 observations; it never reads role
credentials or substitutes Admin/header claims. Unsupported health permissions stop,
not widen IAM. These observations and all native/SQL/load proof remain NOT RUN.

Backup requires explicit app-stop authority and a fresh `--backup-id`: owned pg_dump
and stopped Grafana data stream into encrypted files; secrets/key directories are
suppressed/excluded. Receipts record actual hashes and partial failures. App rollback
requires `--allow-app-stop --rollback-release <actual prior source hash>`, a previously
observed owned release and unchanged protected data contract/pins. It changes app
images only: never reset/restore/downgrade migrations, volumes or retirement markers.
Uncertain SSM/partial steps preserve data and receipts for explicit recovery, not
fake distributed atomicity. Local Windows permissions remain accepted; no new ACL
or backup workflow is started here.

### Historical I3 offline scaffold (superseded checkpoint; not current instructions)

The AWS Compose file is standalone JSON-compatible YAML, **not an overlay** on the
legacy lab. Its only default services are management, postgres and grafana. There
is no Gateway, Prometheus, Telegraf, public DB/app port, build field, Docker socket,
home AWS credentials mount, static AWS key or automatic migrate/seed at startup.
Only Grafana publishes `127.0.0.1:3000:3000`; access remains via a separately
permitted SSM tunnel bound to operator loopback, never `0.0.0.0`.

This is a deliberately **non-executable pre-I4 scaffold**. No image/release
manifest, native lock/evidence, bootstrap bundle or document/preset version was
invented. Both check CLIs currently exit 1 with finite pending issue codes. A
syntactically matching manifest, qualified-looking JSON or `--execute` intent
cannot remove the hard-coded pending consumer/executor gates. No subprocess,
Docker/AWS/SSM/SSH call, network client, secret generation or mutation is implemented
in these CLIs. They do not implement deployment, image publication or a permission
grant. Do not bypass them with direct Compose/build commands.

Safe repository-root checks (no network or application processes):

```text
node --test deploy/tests/aws-deployment.test.mjs tests/aws/contracts.test.mjs
node --check deploy/scripts/build-aws-images.mjs
node --check deploy/scripts/deploy-aws.mjs
node deploy/scripts/build-aws-images.mjs --check
node deploy/scripts/deploy-aws.mjs --check
```

Expected pending build codes with today's missing assets:
`NATIVE_INPUTS_UNAVAILABLE`, `BOOTSTRAP_BUNDLE_UNAVAILABLE`,
`BUILD_BASES_UNAVAILABLE`, `AWS_CONSUMERS_PENDING`, `BUILD_EXECUTOR_UNAVAILABLE`.
Deploy additionally requires a release manifest, existing state, real target and
ownership verification, protected file permissions, explicit operation permission
and an implemented/reviewed executor. Check success is not build/native/IAM proof.
Invalid CLI shapes return exit 2 / `CLI_USAGE`, without echoing input.

### Static input and image contracts

CLIs read only these fixed bounded local public JSON inputs (at most 262144 bytes
per file, regular file, no symlinks, valid UTF-8, duplicate JSON keys rejected):

- `docs/testing/aws/{artifacts.lock,contracts.v1,qualification.v1}.json`: genuine
  I4 inputs, consumed through the I1 validator with `release:true`. Synthetic
  evidence is never admitted by a release CLI. Source/evidence bytes and real
  qualification still require I4 review; syntax is not authenticity.
- `services/management-backend/generated/bootstrap-assets.json`: the **only**
  generated Docker-context exception. N1's planned
  `deploy/scripts/build-ssm-documents.mjs --bootstrap-only` must produce it before
  the image build; N4 extends that builder with configure/decommission documents.
  Bundle schema/hash/evidence adapter is still pending and fails closed, even if
  a JSON file is present. Never fetch a mutable bundle at runtime.
- `deploy/generated/aws-build-inputs.json`: future reviewed object with exactly
  `node`, `go`, `grafana`, `postgres`. Every value must be an official repository,
  explicit version and SHA-256 digest, not a floating tag/default. The scaffold
  accepts Node 24.20.0 bookworm-slim, Go 1.27.1 bookworm and Grafana 13.3.0; these
  are build inputs, not claims that their digests/toolchains were verified here.
  PostgreSQL version/digest, entrypoint UID, filesystem layout and health utility
  must be qualified together before use. No base digest receipt is supplied.
- `deploy/generated/aws-release.json`: future public release metadata with exact
  fields `format` (`infrapulse-aws-release-v1`), `synthetic:false`, `accountId`,
  `region`, `deploymentId`, `instanceId`, `ownership`, `secretDirectory`, `images`,
  `environment`, `delivery`. No extension bags, URLs, shell/CLI arguments or secret contents.
  Ownership declares Project=InfraPulse, Environment and InfraPulseDeployment;
  declaration is not verified EC2 ownership. Region is Singapore. Environment is
  exactly the I2 keys plus the four **actual** N4 positive numeric version strings.
  Role is `infrapulse-<deployment_id>-hybrid`; reserved document/preset names and
  eligibility must match I2 exactly. No invented version 1 or `$LATEST`.

Release `images` has exactly management, grafana, postgres, bootstrap, migrate,
seed and alert-sync. The approved project strategy is **public GHCR publication
only when separately authorized, otherwise reviewed image transfer**. Controller
confirmed namespace `ghcr.io/autoops-platform` and project prefix `infrapulse` from
the project origin. Exact deterministic per-target repositories are:

| Image role | Exact repository (append `@sha256:<actual image digest>`) |
| --- | --- |
| management | `ghcr.io/autoops-platform/infrapulse-management` |
| grafana | `ghcr.io/autoops-platform/infrapulse-grafana` |
| bootstrap | `ghcr.io/autoops-platform/infrapulse-bootstrap` |
| migrate | `ghcr.io/autoops-platform/infrapulse-migrate` |
| seed | `ghcr.io/autoops-platform/infrapulse-seed` |
| alert-sync | `ghcr.io/autoops-platform/infrapulse-alert-sync` |
| postgres | `docker.io/library/postgres` |

This is a **name contract only**: no package existence, public visibility,
publisher permission, registry authentication or actual digest is established.
No arbitrary repoPrefix, foreign/lookalike namespace, wrong-role repository,
mutable tag, ECR provisioning or runtime ECR authentication prerequisite is
introduced. Account/region/deployment/instance/ownership binding remains separate
in the release manifest and must still be independently verified.

Required `delivery` is exactly one of these bounded public metadata shapes:

- `{mode: 'public-ghcr'}` — no extra fields. Actual public package/provenance and
  immutable digest verification remain pending (`PUBLIC_GHCR_UNVERIFIED`). No
  automatic login, publish/pull authority or caller `verified:true` receipt.
- `{mode: 'reviewed-transfer', archives: {...}}` — `archives` has exactly the same
  seven role keys as `images`. Each value has exactly `fileName` and `sha256`.
  Filename is fixed `infrapulse-<role>.oci.tar` (including postgres/alert-sync);
  SHA-256 is the **actual archive-byte checksum**, distinct from the image digest.
  No path, URL, transport command, extra CLI argument or caller importVerified
  boolean is accepted. The exact approved image references above remain the
  intended imported identities; no tag/local-name substitution is inferred.
  `TRANSFER_IMPORT_UNVERIFIED` remains unconditional for this shape. Reopened I3
  must review provenance, validate actual archive bytes, and independently verify
  the imported image's immutable identity/digest against `images` under separate
  transfer/import permission before any use. Docker load/export behavior is not
  assumed to preserve a RepoDigest without this verification. No archive reader,
  transfer/import executor or real verification receipt is supplied here.

These metadata declarations cannot satisfy the native/bundle/state/identity/
ownership/permission/consumer/executor hard gates, even with `synthetic:false`.
Compose variables are MANAGEMENT_IMAGE, GRAFANA_IMAGE, POSTGRES_IMAGE,
BOOTSTRAP_IMAGE, MIGRATE_IMAGE, SEED_IMAGE, ALERT_SYNC_IMAGE. Compose checks
required variables; the release validator checks exact approved repository/digest
syntax and delivery shape. **Compose alone cannot establish immutable/trusted
inputs**. No persistent synthetic manifest is created. Tests use explicitly
synthetic memory-only objects and cannot release.

Only after separate native/build/registry permissions and consumer implementation:
review official amd64 base digests, qualify the native inputs and N1/N4 bundle,
run frozen frontend/Go/backend builds on a suitable builder (not central), review
all seven image targets, resolve actual image digest receipts, and record those
receipts plus the explicit delivery mode in the public release manifest. Publish
the six project images to the exact public GHCR repositories only with separate
publication authority; otherwise use separately reviewed transfer/import with
actual archive and imported-image verification. Review signing or the exact
plugin-ID lab unsigned exception; never use a wildcard. Approved transfer must
preserve the reviewed immutable identity and be verified on import; it is not a
reason to rebuild on central or publish `latest`. No automatic registry authentication,
credential forwarding or publish fallback is provided. Current `--execute` is
intentionally denied; executor implementation and independent review remain work.

### Protected file mount matrix and explicit operations

`INFRAPULSE_SECRET_DIR` must resolve to `/etc/infrapulse/<deployment_id>/secrets`
on the Linux central host, outside the checkout. A future executor must verify
canonical paths, no symlink traversal, root-owned `0700` parent directories,
regular bounded files and container-readable owner-only permissions before any
operation. Local Compose file secrets use bind mounts: `uid/gid/mode` are **not**
a reliable remapping mechanism. Host file ownership and `0400` permissions must
match actual image UIDs (10002 management/operators, 472 Grafana, proposed 999
PostgreSQL pending pinned-image verification). Public trust files also satisfy
Nest's strict file-reader permissions. Docker/root remain trusted; this is not
isolation from the host administrator. Never mount the parent secret directory.

| Consumer | Selective files only |
| --- | --- |
| management runtime | management-db-url, assertion-trust (public), service-trust (public) |
| postgres | postgres-password |
| Grafana / Go plugin | assertion-key (PKCS8 Ed25519; not frontend assets) |
| bootstrap profile (privileged setup only) | bootstrap-db-url, owner-db-url, management-db-url, alert-db-url |
| migrate profile | owner-db-url |
| seed profile | owner-db-url |
| alert-sync profile | alert-db-url (scoped projection/receipt role), grafana-admin |

Canonical explicit job entrypoints remain `scripts/bootstrap-db.ts`,
`scripts/migrate-db.ts`, `scripts/seed-db.ts`, `scripts/sync-grafana-alerts.ts`,
with separately reviewed image targets/digests and credentials. B1 updates the
existing bootstrap/seed scripts; the current legacy 15s/Gateway seed is **not** an
AWS seed. Current migration puts its owner URL into a Prisma child environment:
that secret-env handling requires a scoped future fix, not reuse as compliance.
B7 adds job-only projection/receipt source helpers; the G4 alert CLI/HTTP consumer
now exists as source only (see G4 below). Nothing invokes these commands in I3 checks. These pending
consumers cannot be satisfied by a manifest boolean or the existence of a file.

I3→B7/G4 mount interface: `INFRAPULSE_ALERT_DATABASE_URL_FILE`,
`INFRAPULSE_GRAFANA_ADMIN_FILE`; fixed `INFRAPULSE_GRAFANA_URL=http://127.0.0.1:3000`.
Only the explicit Linux host-network alert job uses loopback Grafana. Postgres has
**no host port**, so this job cannot use Docker DNS `postgres` or host localhost
for DB access. Future executor must resolve/verify the exact owned Compose DB's
host-reachable private bridge endpoint and protect it inside the scoped URL file.
Reachability/owned resolution remain **unproven prerequisites**, not a portable
hardcoded IP guarantee. Do not expose 5432 or add an app proxy to fix this.

A separately authorized operator must create protected credentials once without
printing them, retain encrypted/root-protected backups outside checkout, and
verify file owners/modes and existing DB/key identity on every rerun. Existing
files, roles, passwords, keys and volumes are never replaced/regenerated implicitly.
Missing state is a safe error, not permission to adopt/reset a DB. Bootstrap →
migrate → seed are explicit sequential jobs after image review/backup; none runs
on app start or concurrently to hide a failure. Alert sync remains separate and
operator-only. No `down -v`, volume removal, reset, arbitrary shell, arbitrary URL,
remote command string or automatic reboot is part of the executor contract.

The future deployment CLI accepts only the explicit confirmation form
`--execute --instance-id <id> --deployment-id <id>` matching the reviewed manifest;
this is user intent to the tool, **not** AWS/SSM/deploy/build/publish/reboot permission.
Live account/instance/deployment ownership, a separately reviewed saved-state and
backup contract, and operation-specific permission must be checked independently.
I3 has no authority or implementation to pass those gates.

### B7 source-only operator boundary — UNVERIFIED / unapplied

The new migration follows the five immutable existing migrations, in actual order:
`202611010001_management`, `202611180001_aws_onboarding`,
`202611190001_retry_cursor_constraint`, `202611190002_bootstrap_recovery`,
`202611190003_decommission_protocol`, then `202611190004_alert_sync_operator`.
Readiness requires the sixth migration and denied runtime receipt-function access;
no migration was generated/applied or SQL-qualified by this source change.

Privileged explicit bootstrap alone additionally reads the same protected
`INFRAPULSE_ALERT_DATABASE_URL_FILE` used by the future alert job, solely to create
or validate `management_alert_sync`. All four DB URLs require distinct passwords,
exact roles, the same verified endpoint/database and the management schema for
non-bootstrap roles. The future host-network alert job and bridge bootstrap/runtime
must reach that same privately reachable verified endpoint; resolving it remains
an I3 gate. No plaintext URL/password/argv log, rotation or generation is added.
Existing marked roles are validated, not repaired; foreign/elevated roles,
memberships (including grants of the alert role), object ownership, direct/column/
PUBLIC/default excess privileges are rejected. The reviewed DB must already deny
PUBLIC database TEMP and schema CREATE; bootstrap refuses permissive policy rather
than rewriting unrelated public/database controls. Descriptor reads enforce bounded
regular files, Linux owner-only access and final-component no-follow; full ancestor
custody/Windows ACLs remain unqualified executor prerequisites.

Routine alert login gets schema USAGE, SELECT on the security-barrier safe view and
EXECUTE on one owner-held SECURITY DEFINER receipt function with fixed pg_catalog
search_path and revoked PUBLIC/runtime EXECUTE. No credential/audit/attempt-payload
reads, table DML/DDL, role membership or owner fallback. Runtime only reads receipts
and its existing narrow invalidation trigger can only reset Pending. SQL audit
identifies the operator DB job, not a verified Grafana Admin user; its finite delta
is binding ID, generation, desired hash, state and UID count, never remote errors.

G4 must hold one deployment-wide **session advisory lock** on a dedicated DB
connection through projection → Pending commit → bounded Grafana HTTP → result;
never keep a DB transaction open across HTTP. The CLI, lock acquisition, deadlines,
Grafana ownership-label validation and HTTP reconciliation are implemented by the source-only G4 boundary below, not executed or qualified here.
A disconnect releases that lock, not remote writes: resume the existing Pending
hash/UID intent before a different desired hash; a live different hash is fenced.
Exact replay is idempotent (including unchanged synced_at/audit); Applied may mean
already terminal, so reread before considering further HTTP. Error is not success.
`owned_uids` is last confirmed, `intent_uids` desired (max32), and
`reconciliation_uids` retains potentially written UIDs (max128) until genuine Synced;
capacity exhaustion fences rather than dropping obligations. Canonical UIDs are
`ip_<32 lowercase binding hex>_<4 lowercase alphanumeric rule key>` (40 ASCII
characters). That shape alone never proves remote ownership.

Cleanup projection includes Decommissioning/CleanupRequired **before Retired**.
Use the pure `alertRemovalHash` helper's SHA-256 of UTF-8 JSON.stringify with exact
key order `{schemaVersion:1,action:'remove',bindingId,serverId,enrollmentId,nodeId,generation}`.
Register Pending with that hash and empty desired UIDs without erasing prior UIDs;
only actual remote removal permits matching current-generation Synced/empty UIDs
and a genuine SQL-produced synced_at after cleanup intent. There is no caller
cleanup boolean or distributed rollback guarantee. Removal does not need metric
resources or Active Success.

The approved B5→B7 bridge carries a bounded exact ApplyReceipt only after the SAME
canonical buildQueries + required-metric Verified path, through the existing
internal evidence/state transition to the existing Server/current-generation/
enrollment/lease-fenced repository transaction. A nullable write-once
`verified_config_receipt` stores max32 TOTAL selected resources / max16KiB closed
receipt, bound to current node/platform/preset/config-start/applied times. Runtime
has INSERT/UPDATE only on the old attempt columns, not this new column; a separate
fixed-search_path owner-held storage function rechecks identity/lease/closed bounds.
Success, receipt, monitoring and audit commit in the same short DB transaction.
This guards storage, not physical/native attestation: trusted application B5 code
still owns canonical validation; types or a database JSON write do not prove samples.
Historical/unqualified/new-generation rows remain unavailable until a real B5
Verified observation supplies the receipt. Historical valid receipts are retained,
not copied into another generation. The safe view exposes only selected resources
for matching current Active Success, never whole receipt JSON. G4 must use those
resources with the SAME canonical preset authority; no arbitrary caller manifest,
external JSON, invented metrics or qualified-empty defaults. Missing real data
still fences normal create/update; it never prevents pre-Retired cleanup removal.

Compose selectively adds alert-db-url to privileged bootstrap only. Runtime,
migrate and seed never receive it; Grafana Admin remains alert-job-only. Existing
image source copying already includes these helpers; no CLI/executor was activated,
Dockerfile/deploy validator gate relaxed, image built or qualification claimed.
All build/deploy/publish/cloud/native/SQL/loader qualification gates remain pending.

### I3 reopen checklist — I3 execution work is deferred, not assigned away

This checkpoint completes **only the offline scaffold**, not full I3. Downstream
consumers do not automatically implement I3's missing executors. Reopen I3 after
I4/B4/B5/N4/G1/G3 (and G4 alert consumer) are available, with separate permissions:

1. Implement the N1/N4 bundle schema/hash/evidence adapter and verify real I4
   evidence plus actual immutable document/preset versions; replace no gate with
   a presence check, caller boolean, fabricated receipt or synthetic release mode.
2. Implement/review I3's fixed-argument build boundary, exact Dockerfile targets,
   native bundling order, trusted amd64 base validation, frozen build/production
   dependency closure and actual digest/signing/local transfer or publication
   receipts. No arbitrary shell/URL/extra Docker arguments or central rebuild.
3. Implement/review I3's permission-aware executor and durable saved-state/backup
   contract: real account/instance/ownership and exact confirmation matching,
   state absence/adoption refusal, protected selective file ownership, idempotent
   create-once credentials, no password/key regeneration or volume destruction.
4. Integrate reviewed AWS bootstrap → migrate → seed and scoped G4 alert jobs,
   fix secret-env propagation, resolve/verify the owned host-reachable private DB
   endpoint, and initialize actual Grafana identity without runtime admin mounts.
   Initial admin creation is disabled in Compose; safe operator initialization
   is a pending gate, not a supplied account or qualified Grafana API procedure.
5. After separate build/deploy/native/registry permissions, obtain actual images,
   health/readiness/identity, both SDK IMDSv2, backup/recovery and measured
   RSS/swap/OOM/disk/log headroom evidence under 2 concurrent / 5 active nodes.
   Missing I3 behavior stays pending until implemented and independently reviewed.

### Runtime/resource and cross-task acceptance gates — NOT RUN

Runtime caps: management 384 MiB / 0.5 CPU, postgres 384 MiB / 0.5 CPU, Grafana
512 MiB / 0.75 CPU; one 256 MiB / 0.5 CPU operator job at a time. Default app caps
sum to 1280 MiB; with a job, 1536 MiB leaves 512 MiB nominal for OS/Docker/SSM on
2 GiB. This is a **hypothesis**, not peak RSS or scheduling proof. PID limits,
read-only roots, bounded tmpfs and local rotated logs (10 MiB × 3 per container)
are configuration, not disk/OOM/headroom evidence. PostgreSQL and Grafana SQLite
use named persistent volumes; validate nonroot volume ownership first. Grafana's
persistent `/var/lib/grafana` is data/SQLite only. Frontend + Go plugin code ships
in the image at `/opt/infrapulse/plugins/infrapulse-infrapulse-app`, with the same
fixed `GF_PATHS_PLUGINS=/opt/infrapulse/plugins` in Dockerfile and Compose. No
persistent mount may cover these artifact destinations; existing data cannot
shadow newly reviewed image code. This correction does not move, wipe, migrate
or repair any volume. Actual image permissions/UID/Grafana behavior remain NOT
RUN. Volumes are on I2's replacement-deleted root disk: external backup/recovery
is mandatory.

Readiness checks use Nest `/health/ready`, PostgreSQL `pg_isready`, Grafana
`/api/health`; utility availability/meaning in actual pinned images remains
unverified. G1 must initialize actual Grafana user/admin identity safely without
mounting the admin secret in runtime, and verify the Grafana >=13.3 <13.4 actual
ID-token experimental acknowledgement. Existing Go config's legacy Gateway/
agent-control fields are pending AWS consumers, not defaults to fabricate. G3 now adds a canonical-gated CloudWatch generation SOURCE stage and explicit
image-owned datasource/dashboard provisioning (see below); no generated assets,
installed-plugin behavior or AWS-ready result is supplied. No legacy PromQL alert
or default datasource directory is copied. B4/B5/N4/G1/G3/G4 runtime, migrations, restricted alert role/API and native bundle
acceptance remain pending, along with I4 activation-tag authorization.

Both SDK containers must qualify default instance-profile IMDSv2 access under
separate cloud permission. Bridge egress is retained for that chain. I2 hop limit
2 plus a shared role means the same-host union of backend writes/SSM and metric
reads is available to either compromised container: not per-container IAM isolation.
No keys/profile/home-credentials fallback is allowed. After explicit deployment
permission, verify all three services, actual user-bound identity over loopback
SSM tunnel, both supported native OSes, two concurrent onboardings / five nodes,
peak RSS/swap/OOM/disk/image/log headroom and backup restore. If t3a.small fails,
seek 4 GiB approval; never silently scale. No deployed/build/native evidence exists
from this scaffold or its unit/Compose checks.

## N4 future publication/source handoff — NOT APPLIED

N4 adds source only. Existing applied foundation is not changed by these edits.
`publish_ssm_source` defaults false: no absent generated file is treated as a
ready artifact. Genuine I4 canonical inputs, later authorized generation and a
separately reviewed concrete cloud plan/apply are required before enabling it.
No generated document/preset/evidence, version-1 default or native fact is supplied.

The existing [builder](<../../deploy/scripts/build-ssm-documents.mjs>) adds pure
`compileDocuments` and a future explicit `--documents --linux-tier Standard|Advanced
--windows-tier Standard|Advanced` mode (optional `--check`). This also binds the
existing bootstrap bundle to exact installed lifecycle source hashes. These are
interface spellings, **not** commands authorized or executed in this source task.
All canonical qualification and UTF-8 byte/tier limits are checked before emission;
SSM documents contain finite source-hash wrappers, not large inlined OS modules.

[SSM resources](<../../infra/terraform/ssm.tf>) define exactly owned Configure and
Decommission command documents, two pinned-version canonical preset parameters
and one tag:InfraPulseEligibility association. No multiple-tag AND, wildcard
node target, mutable latest version, per-VM Terraform or runtime document writes.
Document updates create immutable service versions; old preset versions are not
rewritten. Real parameter versions must equal canonical pins or publication fails
closed. Prevent-destroy is not permission to apply, migrate, delete or adopt.

[Outputs](<../../infra/terraform/outputs.tf>) retain Owner and add actual service
Configure/Decommission/preset versions plus actual association ID after publication.
The provider output is **not** assumed to expose AssociationVersion: supply
`observed_config_association_version` only from independently authorized actual
DescribeAssociation readback, never a guessed `1`/latest. Null omits that startup
key and keeps runtime unavailable. The backend independently checks the live
association version/closed parameters/ownership and observed command chain;
input assertions alone cannot attest it. Preserve these keys in protected startup
configuration alongside the same canonical triplet, not browser input.

[Runtime IAM](<../../infra/terraform/iam.tf>) adds only observer reads on the exact
published association ARN, conditionally with source publication. The unused
StartAssociationsOnce grant and broad ListAssociations read were removed; no
node tag/document-write or general shell/storage/service permission was added.
New `202611190005_association_provenance` migration/readiness are additive SOURCE
and unapplied; earlier six migrations remain immutable. The same unapplied authoring
now includes protected once-only retry dispatch and actual invocation-timing
provenance. Retry is a current-generation closed configure command through the same
worker/approved document/version, not a new activation or mutable association.
No original TTL is copied forward, no ambiguous dispatch is blindly replayed, and
prior unknown/inflight operations remain reserved obligations. No build/generator/type/
parser/test/Terraform/native/cloud checks were run. Publication, actual producer
routing/output-source fields, OS/service/credential refresh and effective IAM
remain UNVERIFIED and require later separately authorized testing.

## G3 CloudWatch SOURCE contract — no generated/runtime qualification

- `deploy/scripts/build-cloudwatch-dashboards.mjs` exposes pure
  `compileCloudWatchDashboards(canonical, templates)`. It calls the existing I1
  `validateContracts` with `release:true` and expands the SAME canonical metric
  manifest used by B5; no fourth proof, fabricated native names or qualified flag.
  Both-platform semantic presentation requires artifacts-v4's closed lifecycle
  input→metric-key mapping. v1–v3 are not reinterpreted from output names.
- Future explicit `--check` compiles in memory; `--write` writes only fixed
  `deploy/generated/cloudwatch/{linux-host,windows-host,manifest}.json` after ALL
  inputs compile. Conflicting old output is refused, not silently replaced. These
  spellings are interfaces, NOT commands authorized/executed by this source task.
  No canonical inputs or generated files were produced now. Missing facts fail
  before output/build side effects; I3 preflight invokes this real compiler but
  retains its independent consumer/executor/permission gates.
- The two current host JSON files are SOURCE templates, not dashboards to import.
  The [historical conversion ledger](<../archive/grafana-dashboards/dashboard-conversion.json>) accounts for all
  29 old targets and 8 variables individually, plus the four alert intents handed
  to G4. Optional template selectors emit only canonical metrics actually present;
  old summaries/uptime/load/sample age/unsupported Windows capacities are not
  synthesized. Downloaded originals remain untouched and unprovisioned.
- Each generated series retains full binding/native dimensions, canonical singular
  statistic and aggregation allowlist, exact string period `"60"`, namespace and
  separate resource identity. No cross-resource reduction. Only qualified input
  semantics permit 100-idle/100-free/100-available; inversion uses a negative-gap
  sentinel condition so missing samples are dropped rather than arithmetic zero.
  Windows busy and native network rates are direct; committed RAM is explicit.
- Native dimension variables have injective ASCII hex names and nonmatching
  defaults. The same-origin appSubUrl-aware builder supplies Server/node/enrollment,
  generation/preset and only selected dimensions from the backend nullable closed
  `dashboardContext`. That projection requires nonarchived current Active
  Success/Complete, exact server/platform/account/region/generation/enrollment/
  preset/config times and the protected B5/B7 write-once verified receipt. It
  exports no raw receipt/provider payload, external URL, role or credential.
  Current Monitoring reads inventory, never LegacyServer/Agent/profile identity.
  Onboarding progress stays closed and independent of health/alert sync.
- URL filters are NOT RBAC/current-binding/native proof: Grafana datasource access
  remains its own boundary, and lifecycle changes require a current inventory
  reread. Manual stale/external dashboard URLs are not made authoritative. No
  browser/native attestation or account/region selection is introduced.
- The AWS image's generation stage consumes canonical inputs before frontend/Go
  package/build stages; only its two generated dashboards are copied into
  `/opt/infrapulse/dashboards`. Provider points there; explicit CloudWatch/provider
  files go to `/etc/infrapulse-aws-provisioning`. Compose persists ONLY
  `/var/lib/grafana`; neither SQLite nor a data volume shadows image assets.
  Deny-by-default context admits named source files, never old archives, generated
  checkout dashboards, Prometheus datasource or file alert families.
- Datasource UID `infrapulse-cloudwatch`, default SDK/instance profile, Singapore,
  `InfraPulse/Lab`, no keys/profile/AssumeRole. Cloud-only auth restriction is source
  config; actual plugin version and enforcement remain UNVERIFIED. Do not grant
  Logs just to turn Save & Test green. Shared host IMDS is not IAM isolation.
- Public source anchor: Grafana v13.3.0
  [generated query types](https://github.com/grafana/grafana/blob/v13.3.0/packages/grafana-schema/src/raw/composable/cloudwatch/dataquery/x/types.gen.ts),
  blob `f66c64feca4c4cec3a04c8a8d19586b96771c274`: period STRING,
  singular statistic, Metrics/Search0/Builder0, full dimensions/matchExact. No
  declared Unit filter: canonical unit governs labeling/backend verification,
  NOT a claimed datasource unit-enforcement field or installed-plugin proof.
- All tests/fixtures/build/typecheck/lint/format/schema/generator CLI/native/
  browser/AWS/SQL/Docker checks are DEFERRED by the latest user instruction.
  I4 genuine evidence, plugin/math/render readback, migrations/root wiring,
  frozen images, identity/SDK/IAM, G4 alert sync and I3 executor remain UNVERIFIED.

## G4 operator alert SOURCE boundary — UNVERIFIED / not executed

- `buildDesiredRules` is pure: current B7 selected resources + SAME canonical
  metric manifest and G3 lifecycle semantic mapping. CPU busy 85%, RAM used 90%,
  disk used 90% (Windows free inverted) for 5m. Windows RAM is **committed**, not
  physical. Exact dimensions/statistic/namespace and STRING period `"60"` retained;
  no guessed metric names, counter rate conversion, unit query-filter claim or
  cross-resource reductions. Max5 bindings, max32 TOTAL selected resources, max32
  desired UIDs, max128 retained reconciliation UIDs; canonical UIDs are 40 chars.
- New additive `202611190006_alert_metric_identity` appends **b.activation_id**
  and **a.config_started_at** to the B7 security-barrier view; previous seven
  migrations remain immutable. Readiness requires this finished correction. Only
  the scoped alert login reads this view; no attempt payload, activation code or
  public UI field is added. This migration has NOT been applied.
- Fresh CPU means a finite exact B2 `readMetrics` query with the canonical CPU
  key/full dimensions and actual binding identity. Complete transport alone,
  configAppliedAt, general last-observed timestamps, other groups and empty data
  cannot enable rules. A valid 0–100 CPU sample after config apply and within 300s
  is required; never-seen/Pending remains disabled. An already genuinely armed
  stale rule remains armed independently of other activity: exact CPU 15m lookback,
  NoData=Alerting, executionError=Error, static binding/enrollment labels and a
  threshold >100 that cannot fire on valid CPU. Missing samples are dropped, not 0.
- `createQualifiedRuntime` is the shared finite non-Nest I3/G4 composition. Fixed
  root-owned packaged I1 triplet + existing release validator, canonical N4 producer
  references, bootstrap bundle byte pin, actual N4/association versions and actual
  published DB preset UUIDs are mandatory. No fourth proof file, qualification bool,
  ambient path, version1 default or permanent valid-input stub. Future I3 root MUST
  REUSE this factory; actual app-root/executor wiring remains deferred. Default SDK
  chain is `CallerConfigNoAccountAttestationClaim`, not account attestation or
  per-container IAM isolation. No cloud call was made in this source task.
- The explicit compiled-module operator CLI's future `--check` does local protected
  composition only: no DB/Grafana/AWS request. Future `--execute --deployment-id <id>`
  requires the explicit alert-sync profile, matching fixed deployment, selective
  owner-only files, exact `management_alert_sync` URL and one dedicated deployment
  SESSION advisory lock through projection → HTTP → receipt CAS. No transaction
  spans network. Neither spelling is authorized to run in this task.
- Admin input is ONLY existing `/run/secrets/grafana-admin`, closed JSON
  `{username,password}`, Linux UID10002 owner-only file with root-owned safe
  ancestors. No content is read/replaced here. I3 must preserve/qualify the existing
  file's representation and mounts before use; unsupported input safely refuses.
  It is never mounted in management/Grafana/plugin/migrate/seed. Alert URL has no
  runtime/owner fallback. No bearer, app Admin provider, scheduler, SMTP/contact
  point provisioning, secret creation or password rotation is introduced.
- Client is fixed HTTP `127.0.0.1:3000`, host network, expected org and exact Grafana
  13.3.0. Legacy provisioning API is explicit API authority, not file+API dual
  ownership; AWS image excludes old host-health file rules. Each request has 5s /
  512KiB bounds, no redirects/proxy/raw errors/logged headers/mutation retry.
  Before mutation: own folder plus actual persisted UID obligation + API provenance
  + exact deployment/binding/enrollment/account/region/preset/static labels and
  reconstructed canonical content identity. Prefix, title, self-hash or just-new
  Pending UID is NOT ownership. Foreign collisions require manual review. Empty
  pre-existing unanchored folders refuse mutation; no automatic adoption/deletion.
- Capture previous persisted manifest/intent BEFORE this job Pending. Register exact
  desired hash/UIDs BEFORE folder/rule writes, reread/fence before each mutation and
  terminal CAS, and stop on Fenced. Prior genuine Pending is reconstructed/reconciled;
  obsolete enable intent closes Error with obligations retained before a new intent.
  Partial/lost outcomes retain bounded reconciliation sets; no distributed rollback.
  Actual writes + exact remote readback precede Synced. Disabled/Unknown protection
  remains Error/required, never healthy-zero/empty Synced. Missing binding is a
  fence, not delete authority. CleanupRequired/Decommissioning remove before Retired
  using **unchanged B6 `alertRemovalHash` ordered JSON**, then current-generation CAS.
- Secret matrix remains: runtime DB/trust only; bootstrap four scoped DB files;
  migrate/seed owner only; Grafana assertion key only; alert job alert-db-url/Admin
  only. Host-reachable private owned DB endpoint, file custody, existing Admin/API
  representation, actual Grafana13.3 query normalization/provenance, IAM/default
  chain, qualification, tests/build/typecheck/migrations and all native/cloud gates
  remain **UNVERIFIED**. No rule/contact point/asset generation or CLI was run.
- Public API source context (not installed/native proof):
  [Grafana provisioning API](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/http-api-provisioning/)
  retains legacy rule provisioning, orgID/folderUID and `provenance: api`; API
  mutations omit `X-Disable-Provenance`. Exact pinned runtime schema/readback is a
  later separately authorized gate, not inferred from current-version docs.

## Authoritative public references

- [SSM service authorization Actions/resources/conditions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html)
- [CreateActivation API](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_CreateActivation.html)
- [Hybrid service-role trust](https://docs.aws.amazon.com/systems-manager/latest/userguide/hybrid-multicloud-service-role.html)
- [Central SSM core managed policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html)
- [SSM messaging service authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssmmessages.html)
- [CloudWatch Actions/resources/conditions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudwatch.html)
- [PassRole limitation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html)
- [Terraform local backend](https://developer.hashicorp.com/terraform/language/backend/local)
- [EC2 Terraform resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/instance)
