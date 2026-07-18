-- 出典: apps/blog-api/adapter/src/repository/users_articles.rs
-- UsersArticlesRepositoryImpl::find_published_by_user_name_and_slug
-- 公開側の記事詳細。常に 1 行なので相関サブクエリ方式でタグを 1 行にまとめる。
--
-- playground はステートメントごとに接続を切ることがあり、その場合は
-- セッション変数が引き継がれない。同一トランザクション内で SET と本体クエリを
-- 一括送信するため BEGIN ... COMMIT で囲む。

BEGIN;
SET @slug      = '20260108-shuntaka-blog-rearchitecture';
SET @user_name = 'shuntaka';

WITH RECURSIVE tag_paths AS (
    SELECT tag_id, name AS path
      FROM tags
     WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name)
      FROM tags t
      JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
)
SELECT
    a.article_id,
    a.title,
    a.slug,
    a.user_id,
    a.content,
    a.content_html,
    a.thumbnail,
    a.description,
    a.status,
    (SELECT GROUP_CONCAT(tp.path SEPARATOR ',')
       FROM articles_tags at2
       JOIN tag_paths tp ON at2.tag_id = tp.tag_id
      WHERE at2.article_id = a.article_id) AS tag_names,
    a.published_at,
    a.created_at,
    a.updated_at
FROM articles a
JOIN users u ON a.user_id = u.user_id
WHERE a.status = 'published'
  AND a.slug   = @slug
  AND u.name   = @user_name;
COMMIT;
