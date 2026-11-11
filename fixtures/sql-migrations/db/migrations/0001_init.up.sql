CREATE TABLE IF NOT EXISTS public.users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  org_id INTEGER REFERENCES orgs (id),
  balance NUMERIC(10, 2) DEFAULT 0
);

CREATE TABLE orgs (
  id BIGINT,
  name TEXT NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_users_org ON users (org_id);

-- A function body that creates a table declares nothing.
CREATE FUNCTION touch() RETURNS void AS $$
BEGIN
  CREATE TEMP TABLE scratch (x int);
END
$$ LANGUAGE plpgsql;
