CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"action" varchar(128) NOT NULL,
	"actor_id" varchar(255),
	"target_id" varchar(512),
	"details" jsonb DEFAULT '{}'::jsonb,
	"request_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"aid" varchar(512) PRIMARY KEY NOT NULL,
	"display_name" varchar(256) NOT NULL,
	"handshake_endpoint" text NOT NULL,
	"offered_caps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest_json" text NOT NULL,
	"manifest_expires_at" timestamp with time zone,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"org" varchar(128),
	"cloud" varchar(128),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" varchar(128) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"aid_a" varchar(512),
	"aid_b" varchar(512),
	"session_id" varchar(255),
	"run_id" varchar(255),
	"grants" jsonb,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handshake_sessions" (
	"session_id" varchar(255) PRIMARY KEY NOT NULL,
	"aid_a" varchar(512),
	"aid_b" varchar(512),
	"status" varchar(32) DEFAULT 'started' NOT NULL,
	"grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" varchar(255),
	"boundary" varchar(32),
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revocation_entries" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status_code" integer,
	"error" text,
	"delivered_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret" varchar(255) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_actor_idx" ON "admin_audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agents_registered_at_idx" ON "agents" USING btree ("registered_at");--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "audit_events_ts_idx" ON "audit_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_events_session_idx" ON "audit_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "audit_events_run_id_idx" ON "audit_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "audit_events_aid_a_idx" ON "audit_events" USING btree ("aid_a");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "handshake_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_aid_a_idx" ON "handshake_sessions" USING btree ("aid_a");--> statement-breakpoint
CREATE INDEX "sessions_aid_b_idx" ON "handshake_sessions" USING btree ("aid_b");--> statement-breakpoint
CREATE INDEX "sessions_run_id_idx" ON "handshake_sessions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhooks_active_idx" ON "webhooks" USING btree ("active");