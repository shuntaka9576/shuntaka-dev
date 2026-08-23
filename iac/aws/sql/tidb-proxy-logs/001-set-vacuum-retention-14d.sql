-- cspell:ignore TBLPROPERTIES
ALTER TABLE tidb_proxy_logs.logs SET TBLPROPERTIES (
  'vacuum_max_snapshot_age_seconds' = '1209600',
  'vacuum_min_snapshots_to_keep' = '1',
  'vacuum_max_metadata_files_to_keep' = '100'
);
