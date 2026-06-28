-- Create database (schema name is injected by load.sh as ${SCHEMA})
CREATE DATABASE IF NOT EXISTS `${SCHEMA}`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_bin;
