-- opendb-dsh storage-pg: dsh storage hub kv facet on PostgreSQL (one row per record, one row per unit)
CREATE TABLE IF NOT EXISTS dsh_kv_units (
  unit       text PRIMARY KEY,
  version    integer NOT NULL,
  has_global boolean NOT NULL DEFAULT false,
  global     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dsh_kv_records (
  unit       text NOT NULL REFERENCES dsh_kv_units(unit),
  tbl        text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit, tbl, key)
);
