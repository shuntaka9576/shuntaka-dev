-- 出典: apps/blog-api/adapter/src/repository/users.rs
-- UsersRepositoryImpl::find_by_installation_id
-- GitHub App の installation_id から user_id を引く。管理側の認可で呼ばれる。

SET @github_installation_id = 12345678;  -- BIGINT。実際の値は users.github_installation_id を SELECT で確認

SELECT user_id
FROM users
WHERE github_installation_id = @github_installation_id;
