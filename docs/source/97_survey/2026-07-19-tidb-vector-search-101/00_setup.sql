-- Step 0: 教材テーブルの作成
--
-- blog_dev に使い捨ての教材テーブルを 2 つ作る。終わったら 99_cleanup.sql で消す。
--   * vec_lesson: 4 次元ベクトル 8 行。手計算できるサイズでコサイン類似度〜HNSW を試す
--   * tag_lesson: 7 タグの 3 階層ツリー。再帰 CTE を試す
--
-- vec_lesson の embedding は 4 次元を「トピックの成分」に見立てたおもちゃデータ。
--   [db, frontend, infra, ml] の順。例: tidb-intro = [9,0,2,0] は DB 成分 9、infra 成分 2

DROP TABLE IF EXISTS vec_lesson;
CREATE TABLE vec_lesson (
  id INT PRIMARY KEY,
  label VARCHAR(50) NOT NULL,
  embedding VECTOR(4) NOT NULL
);

INSERT INTO vec_lesson VALUES
  (1, 'tidb-intro',       '[9,0,2,0]'),
  (2, 'mysql-tuning',     '[8,0,1,0]'),
  (3, 'react-hooks',      '[0,9,0,0]'),
  (4, 'nextjs-ssr',       '[1,8,1,0]'),
  (5, 'k8s-basics',       '[1,0,9,0]'),
  (6, 'terraform-aws',    '[0,1,8,0]'),
  (7, 'llm-rag',          '[3,0,1,8]'),
  (8, 'embedding-search', '[6,0,0,7]');

-- 本番の tags と同じ隣接リスト（parent_tag_id で親を指す）。
--   aws ── lambda ── snapstart
--      └── s3
--   frontend ── react
--   misc（子なし）
DROP TABLE IF EXISTS tag_lesson;
CREATE TABLE tag_lesson (
  tag_id INT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  parent_tag_id INT NULL
);

INSERT INTO tag_lesson VALUES
  (1, 'aws',       NULL),
  (2, 'lambda',    1),
  (3, 's3',        1),
  (4, 'snapstart', 2),
  (5, 'frontend',  NULL),
  (6, 'react',     5),
  (7, 'misc',      NULL);

-- 確認
SELECT id, label, VEC_AS_TEXT(embedding) AS embedding FROM vec_lesson;
SELECT tag_id, name, parent_tag_id FROM tag_lesson;
