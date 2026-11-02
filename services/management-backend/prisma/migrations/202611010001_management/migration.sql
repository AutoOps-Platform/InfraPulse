BEGIN;
SET LOCAL search_path = management, pg_catalog;
-- Schema is provisioned by the explicit bootstrap operation. Even IF NOT EXISTS
-- would require database CREATE, which the management-only owner must not hold.

-- CreateTable
CREATE TABLE "servers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "os" VARCHAR(16) NOT NULL,
    "environment" VARCHAR(128) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_group_members" (
    "server_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,

    CONSTRAINT "server_group_members_pkey" PRIMARY KEY ("server_id","group_id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "os_at_registration" VARCHAR(16) NOT NULL,
    "agent_type" VARCHAR(16) NOT NULL DEFAULT 'telegraf',
    "version" VARCHAR(128),
    "version_source" VARCHAR(32),
    "version_reported_at" TIMESTAMPTZ(6),
    "lifecycle" VARCHAR(16) NOT NULL DEFAULT 'active',
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_metric_seen_at" TIMESTAMPTZ(6),
    "last_applied_profile_version_id" UUID,
    "last_applied_at" TIMESTAMPTZ(6),
    "last_config_report_result" VARCHAR(16),
    "last_config_report_at" TIMESTAMPTZ(6),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "public_prefix" VARCHAR(64) NOT NULL,
    "secret_hash" BYTEA NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "retire_at" TIMESTAMPTZ(6),
    "rotated_from_id" UUID,
    "issuance_request_id" UUID NOT NULL,
    "created_by" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_profiles" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(512) NOT NULL,
    "os" VARCHAR(16) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitoring_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_versions" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "created_by" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "profile_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_profiles" (
    "server_id" UUID NOT NULL,
    "profile_version_id" UUID NOT NULL,
    "assigned_by" JSONB NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_profiles_pkey" PRIMARY KEY ("server_id")
);

-- CreateTable
CREATE TABLE "agent_provisioning_receipts" (
    "agent_id" UUID NOT NULL,
    "profile_version_id" UUID NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "first_provisioned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_provisioned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_provisioning_receipts_pkey" PRIMARY KEY ("agent_id","profile_version_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" VARCHAR(16) NOT NULL,
    "actor_issuer" VARCHAR(128) NOT NULL,
    "actor_subject" VARCHAR(128) NOT NULL,
    "actor_display" VARCHAR(128),
    "operation" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(32) NOT NULL,
    "resource_id" UUID NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "request_id" UUID NOT NULL,
    "delta" JSONB NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_nonces" (
    "issuer" VARCHAR(128) NOT NULL,
    "jti" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "request_nonces_pkey" PRIMARY KEY ("issuer","jti")
);

-- CreateTable
CREATE TABLE "gateway_sources" (
    "gateway_id" UUID NOT NULL,
    "current_epoch" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_sources_pkey" PRIMARY KEY ("gateway_id")
);

-- CreateTable
CREATE TABLE "gateway_epochs" (
    "gateway_id" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "boot_id" UUID NOT NULL,
    "boot_started_at" TIMESTAMPTZ(6) NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),
    "last_sequence" BIGINT NOT NULL DEFAULT 0,
    "last_digest" CHAR(64),
    "received_at" TIMESTAMPTZ(6),
    "snapshot_start" TIMESTAMPTZ(6),
    "snapshot_end" TIMESTAMPTZ(6),
    "coverage_start" TIMESTAMPTZ(6),
    "coverage_end" TIMESTAMPTZ(6),
    "gap" BOOLEAN NOT NULL DEFAULT true,
    "pending_sequence" BIGINT,
    "pending_digest" CHAR(64),
    "pending_chunk_hashes" JSONB,
    "pending_payload" JSONB,
    "pending_deadline" TIMESTAMPTZ(6),

    CONSTRAINT "gateway_epochs_pkey" PRIMARY KEY ("gateway_id","epoch")
);

-- CreateIndex
CREATE INDEX "servers_archive_created_id_idx" ON "servers"("archived_at", "created_at", "id");

-- CreateIndex
CREATE INDEX "servers_environment_os_idx" ON "servers"("environment", "os");

-- CreateIndex
CREATE UNIQUE INDEX "server_groups_slug_key" ON "server_groups"("slug");

-- CreateIndex
CREATE INDEX "server_group_members_group_idx" ON "server_group_members"("group_id");

-- CreateIndex
CREATE INDEX "agents_server_lifecycle_idx" ON "agents"("server_id", "lifecycle");

-- CreateIndex
CREATE INDEX "agents_applied_version_idx" ON "agents"("last_applied_profile_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_rotated_from_key" ON "api_credentials"("rotated_from_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_issuance_request_key" ON "api_credentials"("issuance_request_id");

-- CreateIndex
CREATE INDEX "api_credentials_agent_created_idx" ON "api_credentials"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "api_credentials_expiry_retire_revoke_idx" ON "api_credentials"("expires_at", "retire_at", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_id_agent_key" ON "api_credentials"("id", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_profiles_slug_key" ON "monitoring_profiles"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "profile_versions_profile_version_key" ON "profile_versions"("profile_id", "version");

-- CreateIndex
CREATE INDEX "server_profiles_version_idx" ON "server_profiles"("profile_version_id");

-- CreateIndex
CREATE INDEX "agent_provisioning_receipts_version_idx" ON "agent_provisioning_receipts"("profile_version_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_id_idx" ON "audit_logs"("created_at", "id");

-- CreateIndex
CREATE INDEX "audit_logs_resource_created_idx" ON "audit_logs"("resource_type", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs"("actor_issuer", "actor_subject", "created_at");

-- CreateIndex
CREATE INDEX "request_nonces_expiry_idx" ON "request_nonces"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_epochs_source_boot_key" ON "gateway_epochs"("gateway_id", "boot_id");

-- AddForeignKey
ALTER TABLE "server_group_members" ADD CONSTRAINT "server_group_members_server_fk" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "server_group_members" ADD CONSTRAINT "server_group_members_group_fk" FOREIGN KEY ("group_id") REFERENCES "server_groups"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_server_fk" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_applied_version_fk" FOREIGN KEY ("last_applied_profile_version_id") REFERENCES "profile_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_rotated_from_fk" FOREIGN KEY ("rotated_from_id") REFERENCES "api_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_profile_fk" FOREIGN KEY ("profile_id") REFERENCES "monitoring_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "server_profiles" ADD CONSTRAINT "server_profiles_server_fk" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "server_profiles" ADD CONSTRAINT "server_profiles_version_fk" FOREIGN KEY ("profile_version_id") REFERENCES "profile_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_provisioning_receipts" ADD CONSTRAINT "agent_provisioning_receipts_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_provisioning_receipts" ADD CONSTRAINT "agent_provisioning_receipts_version_fk" FOREIGN KEY ("profile_version_id") REFERENCES "profile_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "gateway_epochs" ADD CONSTRAINT "gateway_epochs_source_fk" FOREIGN KEY ("gateway_id") REFERENCES "gateway_sources"("gateway_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints not expressible in the Prisma datamodel remain database authority.
CREATE UNIQUE INDEX agents_one_active_per_server ON management.agents(server_id) WHERE lifecycle='active';
ALTER TABLE management.servers ADD CONSTRAINT servers_os_check CHECK (os IN ('linux','windows')),
  ADD CONSTRAINT servers_metadata_check CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=4096);
ALTER TABLE management.agents ADD CONSTRAINT agents_os_check CHECK (os_at_registration IN ('linux','windows')),
  ADD CONSTRAINT agents_type_check CHECK (agent_type='telegraf'),
  ADD CONSTRAINT agents_lifecycle_check CHECK (lifecycle IN ('active','disabled','retired')),
  ADD CONSTRAINT agents_retired_time_check CHECK ((lifecycle='retired')=(retired_at IS NOT NULL)),
  ADD CONSTRAINT agents_report_result_check CHECK (last_config_report_result IN ('applied','failed'));
ALTER TABLE management.api_credentials ALTER COLUMN scopes SET NOT NULL;
ALTER TABLE management.api_credentials ADD CONSTRAINT api_credentials_hash_check CHECK (octet_length(secret_hash)=32),
  ADD CONSTRAINT api_credentials_scopes_check CHECK (cardinality(scopes)>0 AND scopes <@ ARRAY['metrics:write','provisioning:read','config:report']::text[]),
  ADD CONSTRAINT api_credentials_expiry_check CHECK (expires_at>created_at AND expires_at<=created_at+interval '365 days'),
  ADD CONSTRAINT api_credentials_rotation_self_check CHECK (rotated_from_id IS DISTINCT FROM id),
  ADD CONSTRAINT api_credentials_rotation_agent_fk FOREIGN KEY(rotated_from_id,agent_id) REFERENCES management.api_credentials(id,agent_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE management.monitoring_profiles ADD CONSTRAINT monitoring_profiles_os_check CHECK (os IN ('linux','windows'));
ALTER TABLE management.profile_versions ADD CONSTRAINT profile_versions_positive_check CHECK (version>0),
  ADD CONSTRAINT profile_versions_status_check CHECK (status IN ('draft','published')),
  ADD CONSTRAINT profile_versions_publish_time_check CHECK ((status='published')=(published_at IS NOT NULL)),
  ADD CONSTRAINT profile_versions_config_check CHECK (jsonb_typeof(config)='object' AND octet_length(config::text)<=65536),
  ADD CONSTRAINT profile_versions_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$');
ALTER TABLE management.agent_provisioning_receipts ADD CONSTRAINT agent_receipts_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT agent_receipts_time_check CHECK(last_provisioned_at>=first_provisioned_at);
ALTER TABLE management.audit_logs ADD CONSTRAINT audit_logs_actor_check CHECK (actor_kind IN ('user','service','agent')),
  ADD CONSTRAINT audit_logs_outcome_check CHECK (outcome IN ('success','failed','denied')),
  ADD CONSTRAINT audit_logs_delta_check CHECK (jsonb_typeof(delta)='object' AND octet_length(delta::text)<=4096);
ALTER TABLE management.gateway_sources ADD CONSTRAINT gateway_sources_epoch_check CHECK (current_epoch>=0);
ALTER TABLE management.gateway_epochs ADD CONSTRAINT gateway_epochs_sequence_check CHECK (epoch>0 AND last_sequence>=0 AND (pending_sequence IS NULL OR pending_sequence>last_sequence)),
  ADD CONSTRAINT gateway_epochs_payload_check CHECK (pending_payload IS NULL OR octet_length(pending_payload::text)<=262144),
  ADD CONSTRAINT gateway_epochs_hashes_check CHECK (pending_chunk_hashes IS NULL OR (jsonb_typeof(pending_chunk_hashes)='object' AND octet_length(pending_chunk_hashes::text)<=1024)),
  ADD CONSTRAINT gateway_epochs_pending_check CHECK ((pending_sequence IS NULL AND pending_digest IS NULL AND pending_chunk_hashes IS NULL AND pending_payload IS NULL AND pending_deadline IS NULL) OR (pending_sequence IS NOT NULL AND pending_digest IS NOT NULL AND pending_chunk_hashes IS NOT NULL AND pending_payload IS NOT NULL AND pending_deadline IS NOT NULL));

CREATE FUNCTION management.enforce_agent_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.server_id IS DISTINCT FROM OLD.server_id OR (OLD.lifecycle='retired' AND NEW.lifecycle<>'retired') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Agent history is immutable';
  END IF;
  IF OLD.last_metric_seen_at IS NOT NULL AND (NEW.last_metric_seen_at IS NULL OR NEW.last_metric_seen_at<OLD.last_metric_seen_at) THEN
    NEW.last_metric_seen_at=OLD.last_metric_seen_at;
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER agents_history BEFORE UPDATE ON management.agents FOR EACH ROW EXECUTE FUNCTION management.enforce_agent_history();
CREATE FUNCTION management.enforce_profile_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='profile_versions' THEN
    IF OLD.status='published' AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Published version is immutable'; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  ELSE
    IF NEW.os IS DISTINCT FROM OLD.os THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Profile OS is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profile_versions_history BEFORE UPDATE OR DELETE ON management.profile_versions FOR EACH ROW EXECUTE FUNCTION management.enforce_profile_history();
CREATE TRIGGER monitoring_profiles_history BEFORE UPDATE ON management.monitoring_profiles FOR EACH ROW EXECUTE FUNCTION management.enforce_profile_history();

REVOKE ALL ON ALL TABLES IN SCHEMA management FROM PUBLIC, management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.servers TO management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.server_groups TO management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.server_group_members TO management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.agents TO management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.api_credentials TO management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.monitoring_profiles TO management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.profile_versions TO management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.server_profiles TO management_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON management.agent_provisioning_receipts TO management_runtime;
GRANT SELECT,INSERT ON management.audit_logs TO management_runtime;
GRANT SELECT,INSERT,DELETE ON management.request_nonces TO management_runtime;
GRANT SELECT,UPDATE ON management.gateway_sources TO management_runtime;
GRANT SELECT,INSERT,UPDATE ON management.gateway_epochs TO management_runtime;
GRANT SELECT ON management._prisma_migrations TO management_runtime;
REVOKE ALL ON FUNCTION management.enforce_agent_history() FROM PUBLIC,management_runtime;
REVOKE ALL ON FUNCTION management.enforce_profile_history() FROM PUBLIC,management_runtime;
COMMIT;
