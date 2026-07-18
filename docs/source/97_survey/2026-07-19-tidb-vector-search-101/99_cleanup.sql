-- Step 99: 片付け
--
-- 教材テーブルを削除する。TiFlash レプリカ・ベクトルインデックスも一緒に消える。

DROP TABLE IF EXISTS sales_lesson;
DROP TABLE IF EXISTS vec_lesson;
DROP TABLE IF EXISTS tag_lesson;

-- 消えたことの確認（0 行になれば OK）
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'blog_dev' AND table_name IN ('sales_lesson', 'vec_lesson', 'tag_lesson');
