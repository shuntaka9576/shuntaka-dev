-- 出典: apps/blog-api/adapter/src/repository/health.rs
-- HealthCheckRepositoryImpl::check_db
-- 接続プールが生きていることを確認するだけの最小クエリ。

SELECT 1;
