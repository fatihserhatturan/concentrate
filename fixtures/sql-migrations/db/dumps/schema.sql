-- Baseline dump, read before the migrations.
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
