CREATE TABLE IF NOT EXISTS shelf_library (
  id uuid PRIMARY KEY,
  product_key text NOT NULL,
  product jsonb NOT NULL,
  candidate jsonb NOT NULL,
  image bytea NOT NULL CHECK (octet_length(image) <= 2097152),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shelf_library_key ON shelf_library(product_key, created_at DESC);
ALTER TABLE shelf_library ADD COLUMN IF NOT EXISTS image_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS shelf_library_image ON shelf_library(product_key,image_hash) WHERE image_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS shelf_jobs (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL UNIQUE,
  product jsonb NOT NULL,
  options jsonb NOT NULL,
  refresh boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shelf_jobs_claim ON shelf_jobs(available_at, created_at) WHERE status IN ('queued','retry','running');
CREATE TABLE IF NOT EXISTS shelf_source_slots (
  host text PRIMARY KEY,
  next_at timestamptz NOT NULL
);
ALTER TABLE shelf_source_slots ADD COLUMN IF NOT EXISTS cooldown_until timestamptz NOT NULL DEFAULT '-infinity';
CREATE TABLE IF NOT EXISTS shelf_worker_lease (
  name text PRIMARY KEY,
  token uuid NOT NULL,
  lease_until timestamptz NOT NULL
);
