CREATE TABLE "enrollment_jtis" (
	"jti" varchar(64) PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "enrollment_jtis_expires_at_idx" ON "enrollment_jtis" USING btree ("expires_at");