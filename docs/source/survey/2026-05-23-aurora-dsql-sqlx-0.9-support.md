# aurora-dsql-sqlx-connector の sqlx 0.9 対応トラッキング

- 対象 issue: <https://github.com/awslabs/aurora-dsql-connectors/issues/518>
- 起票日: 2026-05-23
- ステータス: open（メンテからのレスポンス待ち）

## ローカルへの影響

- Renovate PR [#410](https://github.com/shuntaka9576/shuntaka-dev/pull/410) (sqlx 0.8.6 → 0.9.0) がブロック中。upstream 対応まで再オープン不可
- `apps/blog-api/adapter` が `aurora-dsql-sqlx-connector` 経由で sqlx 0.8 系に固定される

## 暫定対応の方針

- PR #410 はクローズして 0.8 系を維持
- `renovate.json` で sqlx の major-equivalent bump を抑止する packageRule を追加（未対応）

## 次のアクション

- [ ] メンテのレスポンスを待つ
- [ ] レスポンスなしが 2〜3 週間続いたら fork から draft PR を出す
- [ ] upstream 対応リリース後、sqlx を 0.9 に上げる PR を投げ直す
- [ ] Renovate の suppress ルール解除
