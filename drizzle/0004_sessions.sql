CREATE TABLE "session" (
	"sid" varchar(255) PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "session" USING btree ("expire");