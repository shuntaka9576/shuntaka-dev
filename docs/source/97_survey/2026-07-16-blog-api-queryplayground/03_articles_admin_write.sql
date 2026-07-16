-- 出典: apps/blog-api/adapter/src/repository/articles.rs
-- ArticlesRepositoryImpl::upsert_article
-- 管理側 upsert の articles テーブル本体への書き込み。
-- 実装ではトランザクション内で
--   (a) 04_articles_tags_sync.sql
--   (b) 05_tag_article_counts_sync.sql
-- と組み合わせて実行される。playground で試すときは ROLLBACK 前提。

-- ────────────────────────────────────
-- (1) UPDATE: 既存記事の更新
-- ────────────────────────────────────
--   content_html は Some のときだけ差し替え、None のときは既存値維持
--   published_at は初回 publish 遷移時のみ NOW に更新（それ以外は既存値を渡し直す）
-- ────────────────────────────────────

SET @title         = '書き換え後タイトル';
SET @content       = '# markdown 本文';
SET @content_html  = NULL;             -- 生成済みの HTML を渡すなら文字列
SET @thumbnail     = NULL;             -- 画像 URL / NULL
SET @description   = 'カード用の要約';
SET @status        = 'published';      -- 'draft' | 'published'
SET @published_at  = '2026-01-08 00:00:00';  -- 既存値 or 初 publish 時の now
SET @updated_at    = NOW();
SET @article_id    = '00000000-0000-0000-0000-000000000000';

START TRANSACTION;

UPDATE articles
   SET title        = @title,
       content      = @content,
       content_html = COALESCE(@content_html, content_html),
       thumbnail    = @thumbnail,
       description  = @description,
       status       = @status,
       published_at = @published_at,
       updated_at   = @updated_at
 WHERE article_id = @article_id;

-- 変更を確定したいときは COMMIT に差し替える
ROLLBACK;


-- ────────────────────────────────────
-- (2) INSERT: 新規記事の作成
-- ────────────────────────────────────

SET @new_article_id = UUID();
SET @user_id        = '00000000-0000-0000-0000-000000000000';
SET @new_title      = '新規記事タイトル';
SET @new_slug       = 'new-article-slug';
SET @new_content    = '# markdown';
SET @new_content_html = NULL;
SET @new_thumbnail  = NULL;
SET @new_description = '要約';
SET @new_status     = 'draft';                -- 'draft' | 'published'
SET @new_published_at = NULL;                 -- draft は NULL、published は NOW
SET @now            = NOW();

START TRANSACTION;

INSERT INTO articles (
    article_id,
    user_id,
    title,
    slug,
    content,
    content_html,
    thumbnail,
    description,
    status,
    published_at,
    created_at,
    updated_at
) VALUES (
    @new_article_id,
    @user_id,
    @new_title,
    @new_slug,
    @new_content,
    @new_content_html,
    @new_thumbnail,
    @new_description,
    @new_status,
    @new_published_at,
    @now,
    @now
);

ROLLBACK;
