-- 出典: apps/blog-api/adapter/src/repository/users_moments.rs
-- UsersMomentsRepositoryImpl::find_published_by_user_name
-- 撮影時刻 captured_at 降順（同時刻は moment_id 降順でタイブレーク）で
-- カーソルベースにページングする。

-- LIMIT は MySQL / TiDB 仕様で @var を受け付けないため
-- （リテラル整数 or prepared placeholder のみ）、各クエリの LIMIT 20 を直接書き換える。
SET @user_name = 'shuntaka';

-- ────────────────────────────────────
-- (A) カーソルなし（初回）
-- ────────────────────────────────────

SELECT m.moment_id, m.text, m.image_key, m.fastener, m.fastener_color, m.captured_at
  FROM moments m
 WHERE m.user_id = (SELECT user_id FROM users WHERE name = @user_name)
   AND m.status  = 'published'
 ORDER BY m.captured_at DESC, m.moment_id DESC
 LIMIT 20;


-- ────────────────────────────────────
-- (B) カーソルあり
--   前ページ末尾の (captured_at, moment_id) をそのまま渡してタプル比較する
-- ────────────────────────────────────

SET @cursor_captured_at = '2026-07-15 12:34:56';                          -- DATETIME
-- cspell:disable-next-line
SET @cursor_moment_id   = '01ABCDEFGHJKMNPQRSTVWXYZ00';                   -- CHAR(26) ULID

SELECT m.moment_id, m.text, m.image_key, m.fastener, m.fastener_color, m.captured_at
  FROM moments m
 WHERE m.user_id = (SELECT user_id FROM users WHERE name = @user_name)
   AND m.status  = 'published'
   AND (m.captured_at, m.moment_id) < (@cursor_captured_at, @cursor_moment_id)
 ORDER BY m.captured_at DESC, m.moment_id DESC
 LIMIT 20;
