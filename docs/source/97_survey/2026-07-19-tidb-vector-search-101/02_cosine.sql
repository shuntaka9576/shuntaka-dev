-- Step 2: コサイン類似度 = 「ベクトルの向きがどれだけ近いか」
--
-- VEC_COSINE_DISTANCE は距離（distance）を返す。distance = 1 - コサイン類似度。
--   0 = 同じ向き / 1 = 直交（無関係）/ 2 = 真逆
-- ポイントは「長さは無視して向きだけ見る」こと。

-- (1) 基本の 4 パターン + 長さ不変の確認
--   期待値: 0 / 0.2929 (45度) / 1 (90度) / 2 (180度)、長さが違っても向きが同じなら 0
SELECT VEC_COSINE_DISTANCE('[1,0,0,0]', '[1,0,0,0]')  AS same_direction,          -- 0
       VEC_COSINE_DISTANCE('[1,0,0,0]', '[1,1,0,0]')  AS deg45,                   -- 0.2929
       VEC_COSINE_DISTANCE('[1,0,0,0]', '[0,1,0,0]')  AS deg90,                   -- 1
       VEC_COSINE_DISTANCE('[1,0,0,0]', '[-1,0,0,0]') AS deg180,                  -- 2
       VEC_COSINE_DISTANCE('[1,0,0,0]', '[2,0,0,0]')  AS same_direction_diff_len; -- 0

-- (2) 組み込み関数と定義式が一致することを確認
--   コサイン類似度 = 内積 / (ノルムの積)。distance = 1 - それ。
--   期待値: builtin = manual = 0.023813
SELECT VEC_COSINE_DISTANCE('[9,0,2,0]', '[1,0,0,0]') AS builtin,
       1 - ( -VEC_NEGATIVE_INNER_PRODUCT('[9,0,2,0]', '[1,0,0,0]')
             / (VEC_L2_NORM('[9,0,2,0]') * VEC_L2_NORM('[1,0,0,0]')) ) AS manual;

-- (3) 落とし穴: 全 0 ベクトルはノルムが 0 でコサインが定義できず NULL になる
--   （playground でダミーを作るとき先頭だけ 1 にするのはこのため）
--   期待値: NULL
SELECT VEC_COSINE_DISTANCE('[1,0,0,0]', '[0,0,0,0]') AS zero_vector;
