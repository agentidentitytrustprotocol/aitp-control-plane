CREATE TABLE "delegations" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"parent_jti" uuid NOT NULL,
	"delegator_aid" varchar(512) NOT NULL,
	"delegatee_aid" varchar(512) NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issued_tcts" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"issuer_aid" varchar(512) NOT NULL,
	"subject_aid" varchar(512) NOT NULL,
	"audience_aid" varchar(512) NOT NULL,
	"grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"binding_cnf" varchar(128),
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"session_id" varchar(255),
	"revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinned_keys" (
	"namespace" varchar(128) DEFAULT 'default' NOT NULL,
	"aid" varchar(512) NOT NULL,
	"pubkey" varchar(128) NOT NULL,
	"label" varchar(128),
	"added_by" varchar(255),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pinned_keys_namespace_aid_pk" PRIMARY KEY("namespace","aid")
);
--> statement-breakpoint
CREATE TABLE "trust_anchors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"namespace" varchar(128) DEFAULT 'default' NOT NULL,
	"issuer_url" text NOT NULL,
	"jwks_url" text,
	"jwks_cache" jsonb,
	"jwks_cached_at" timestamp with time zone,
	"label" varchar(128),
	"added_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "delegations_parent_idx" ON "delegations" USING btree ("parent_jti");--> statement-breakpoint
CREATE INDEX "delegations_delegator_idx" ON "delegations" USING btree ("delegator_aid");--> statement-breakpoint
CREATE INDEX "delegations_delegatee_idx" ON "delegations" USING btree ("delegatee_aid");--> statement-breakpoint
CREATE INDEX "issued_tcts_issuer_idx" ON "issued_tcts" USING btree ("issuer_aid");--> statement-breakpoint
CREATE INDEX "issued_tcts_subject_idx" ON "issued_tcts" USING btree ("subject_aid");--> statement-breakpoint
CREATE INDEX "issued_tcts_audience_idx" ON "issued_tcts" USING btree ("audience_aid");--> statement-breakpoint
CREATE INDEX "issued_tcts_session_idx" ON "issued_tcts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "issued_tcts_grants_gin" ON "issued_tcts" USING gin ("grants");--> statement-breakpoint
CREATE INDEX "pinned_keys_aid_idx" ON "pinned_keys" USING btree ("aid");--> statement-breakpoint
CREATE INDEX "trust_anchors_namespace_idx" ON "trust_anchors" USING btree ("namespace");