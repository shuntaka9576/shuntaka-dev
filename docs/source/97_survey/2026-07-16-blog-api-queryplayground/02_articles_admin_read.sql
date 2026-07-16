-- 出典: apps/blog-api/adapter/src/repository/articles.rs
-- ArticlesRepositoryImpl::find_by_user_id_and_slug
-- 管理側 upsert 前の既存判定で呼ばれる。タグは隣接リストを再帰 CTE でフルパスに展開し
-- GROUP_CONCAT で 1 行にまとめて返す。

SET @user_id = '00000000-0000-0000-0000-000000000000';  -- users.user_id (CHAR(36))
SET @slug    = '20260108-shuntaka-blog-rearchitecture';

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
WHERE a.user_id = @user_id
  AND a.slug    = @slug;
