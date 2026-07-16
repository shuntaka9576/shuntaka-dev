-- 出典: apps/blog-api/adapter/src/repository/users.rs
-- UsersRepositoryImpl::find_by_installation_id
-- GitHub App の installation_id から user_id を引く。管理側の認可で呼ばれる。
--
-- playground はステートメントごとに接続を切ることがあり、その場合は
-- セッション変数が引き継がれない。同一トランザクション内で SET と本体クエリを
-- 一括送信するため BEGIN ... COMMIT で囲む。

BEGIN;
SET @github_installation_id = 12345678;  -- BIGINT。実際の値は users.github_installation_id を SELECT で確認

SELECT user_id
FROM users
WHERE github_installation_id = @github_installation_id;
COMMIT;
