CREATE UNIQUE INDEX IF NOT EXISTS "idx_performers_handle_lower" ON "performers" USING btree (lower("handle")) WHERE "handle" IS NOT NULL;
