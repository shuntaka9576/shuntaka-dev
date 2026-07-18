-- Step 6: 再帰 CTE = 「親子リストを何段でも辿る」SQL
--
-- タグは parent_tag_id で親を指す隣接リスト。「aws 指定で子孫の記事も拾う」には
-- aws → lambda → snapstart と何段でも辿る必要があり、それをやるのが WITH RECURSIVE。
-- 構造は必ず 2 パート。
--   * anchor（UNION ALL の上）: 出発点の行。最初に 1 回だけ評価される
--   * recursive（UNION ALL の下）: 「前のラウンドで増えた行」を参照して次の行を足す。
--     何も増えなくなったら終了

-- (1) まず anchor だけ実行してみる（= 再帰なしならこれしか取れない）
--   期待値: aws の 1 行だけ
SELECT tag_id, name FROM tag_lesson WHERE tag_id = 1;

-- (2) 再帰 CTE で aws の子孫を全部辿る
--   depth は「どのラウンドで追加されたか」。実行イメージ:
--     ラウンド 0 (anchor):    aws
--     ラウンド 1: 親が aws の行         → lambda, s3
--     ラウンド 2: 親が lambda / s3 の行 → snapstart
--     ラウンド 3: 親が snapstart の行   → 無し。終了
--   期待値: aws(0) / lambda(1), s3(1) / snapstart(2) の 4 行
WITH RECURSIVE descendants AS (
    SELECT tag_id, name, 0 AS depth
      FROM tag_lesson WHERE tag_id = 1
    UNION ALL
    SELECT t.tag_id, t.name, d.depth + 1
      FROM tag_lesson t
      JOIN descendants d ON t.parent_tag_id = d.tag_id
)
SELECT * FROM descendants ORDER BY depth, tag_id;

-- (3) 本番形: root_tag_id を持ち回って 2 系列を同時に展開する
--   タグ 2 件 AND 検索では「aws 系列を持つ」「frontend 系列を持つ」を記事ごとに
--   別々に判定したい。そのため anchor で自分自身を root_tag_id として刻み、
--   recursive で親の root_tag_id を引き継ぐ。各行が「どの系列の子孫か」を覚える。
--   期待値:
--     root_tag_id = 1 (aws):      aws, lambda, s3, snapstart
--     root_tag_id = 5 (frontend): frontend, react
WITH RECURSIVE tag_descendants AS (
    SELECT tag_id, name, tag_id AS root_tag_id
      FROM tag_lesson WHERE tag_id IN (1, 5)
    UNION ALL
    SELECT t.tag_id, t.name, td.root_tag_id
      FROM tag_lesson t
      JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT * FROM tag_descendants ORDER BY root_tag_id, tag_id;

-- (4) root_tag_id が無いとどうなるかを見る（OR 用の形）
--   系列の区別が消え「どちらかの子孫」の集合になる。OR フィルタならこれで足りるが、
--   AND フィルタは「aws 系列に属するか」を単独で問えなくなるため成立しない。
--   本番クエリ（08_users_articles_search.sql）の B 節と C 節の差がまさにここ。
WITH RECURSIVE tag_descendants AS (
    SELECT tag_id, name FROM tag_lesson WHERE tag_id IN (1, 5)
    UNION ALL
    SELECT t.tag_id, t.name
      FROM tag_lesson t
      JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT * FROM tag_descendants ORDER BY tag_id;
