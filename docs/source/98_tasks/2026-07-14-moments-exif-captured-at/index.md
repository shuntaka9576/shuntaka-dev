# moments の日付を EXIF 撮影時刻 (captured_at) に移行

- 起票日: 2026-07-14
- 関連: [logs 管理画面のアーキテクチャ決定と実装計画](../2026-07-12-logs-admin-architecture/index.md) / [logs 機能の構想と UI モック](../2026-07-12-logs-feature/index.md)
- ステータス: 実装完了（DB 再作成 + 再アップロードは未実施）

## 起票理由

moments の表示日付はこれまで `published_at` で、管理画面の日付ピッカーで手動指定していた。写真自体が EXIF に撮影時刻を持っているため、アップロード時にクライアント（admin-web）で EXIF を解析して撮影時刻 `captured_at` として補完し、表示・ソートをそれに一本化する。

これで次の 3 点が同時に解決する。

1. 日付の明示指定が不要になる（ピッカー廃止）
2. 公開一覧のページングが「moment_id カーソル + 行サブクエリ + COALESCE」の複雑なクエリから、`(captured_at, moment_id)` の単純なタプル比較になる
3. 「下書きに戻すと published_at がワイプされ、再公開すると当日の日付でフィード先頭に飛ぶ」問題が解消する（表示・ソートが captured_at になり、published_at は初回公開時刻の記録に役割が変わる）

なお配信画像は canvas 再エンコードで EXIF（GPS 含む）を意図的に落としているため、アップロード前のオリジナルファイルをクライアントで読むのが撮影時刻を取れる唯一の機会。サーバー側や配信画像からの解析は選択肢にならない。

## 設計方針

| 論点              | 決定                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| captured_at       | `DATETIME(6) NOT NULL`。表示・ソートに使う。クライアントが EXIF (`DateTimeOriginal` → `CreateDate`) → ファイル更新日時 → 現在時刻の順で補完して送る                   |
| published_at      | 初回公開時刻の記録として存続。published へ遷移した時点でサーバーが打刻し、draft に戻しても保持（articles と同じ挙動）。表示・ソートには使わない                       |
| EXIF 解析         | admin-web に `exifr` を追加。EXIF はタイムゾーンを持たないため端末ローカル TZ で解釈（国内撮影 + JST 端末なら実時刻と一致）                                           |
| 撮影時刻の編集    | できない。写真を差し替えたときのみ再補完して送る。公開/下書きの切替では変わらない                                                                                     |
| feed インデックス | `(user_id, status, published_at, moment_id)` → `(user_id, status, captured_at, moment_id)` に張り替え                                                                 |
| 公開 API カーソル | `<captured_at unix micros>_<moment_id>` に変更。moment_id (ULID) は作成順で撮影順と一致しないため複合が必須。DATETIME(6) はマイクロ秒精度でカーソルと正確に往復できる |
| 既存データ        | 移行バッチは作らない（アップロード済み画像は EXIF 除去済みで撮影時刻を復元できない）。テーブルを再作成して管理画面から再アップロードする                              |

## 変更内容

### スキーマ (tools/dsql-cli/dsl-tidb/schema/07_moments.sql)

- `captured_at DATETIME(6) NOT NULL` を追加、`published_at` は「初回公開時刻の記録。draft に戻しても保持」にコメント変更
- `idx_moments_feed` を `(user_id, status, captured_at, moment_id)` に変更

### apps/admin-web

- `features/moment-form/lib/captured-at.ts` 新設。`exifr` で `DateTimeOriginal` → `CreateDate` を読み、なければ `file.lastModified`、それもなければ現在時刻にフォールバック。取得元 (`exif` / `file` / `now`) も返す
- `moment-form.tsx`: 日付ピッカーを削除し、ファイル選択時に撮影日時を自動解析して読み取り専用表示（取得元ラベル付き）。新規投稿は `capturedAt` を必ず送り、編集は写真差し替え時のみ送る
- `preview-url.ts`: `date` パラメータに撮影時刻の ISO 文字列を渡す
- `moments-page.tsx`: 一覧の日付を「撮影 …」+ published のみ「公開 …」の 2 表示に変更
- 二重送信の修正: 従来は mutation 中しか送信ボタンを無効化しておらず、画像圧縮 + アップロード中（数秒）に再クリックすると投稿が 2 件できた。送信を「画像アップロード中… → 保存中…」の段階表示に変えて全区間で無効化し、ref でも再入を防止

### apps/admin-api

- `createMomentBodySchema`: `capturedAt` (ISO 8601) を必須化。`updateMomentBodySchema`: optional
- POST: `captured_at` は body から、`published_at` は published なら現在時刻・draft なら NULL
- PATCH: `captured_at` は body にあるときのみ更新。`published_at` は published 遷移時に未打刻なら現在時刻、**draft に戻してもワイプしない**（従来の `status === 'draft'` で NULL にするロジックを削除）
- レスポンスに `capturedAt` を追加、`publishedAt` は nullable のまま存続

### apps/blog-api

- `kernel`: `MomentSummary.published_at` → `captured_at`。`find_published_by_user_name` のカーソル引数を `Option<&str>` → `Option<(DateTime<Utc>, &str)>` に変更
- `adapter`: 一覧 SQL を `ORDER BY m.captured_at DESC, m.moment_id DESC` + `(m.captured_at, m.moment_id) < (?, ?)` に単純化（COALESCE と行サブクエリを廃止）
- `api` handler: カーソルの parse/encode（`<micros>_<moment_id>`）を追加しユニットテストで往復を検証。レスポンス `publishedAt` → `capturedAt`

### apps/web

- `MomentSummary.publishedAt` → `capturedAt`（`lib/api.ts`）。カーソルは opaque に受け渡すだけなので変更なし
- `MomentCard` の日付表示、`/moments/preview`、stories を追随

## リリース手順

デプロイ前にテーブルを再作成する。旧 blog-api は新テーブルでも動く（published_at が残っており、行が空なら COALESCE も踏まない）が、新 blog-api は captured_at がないテーブルでは 500 になるため、**DB 先行**が正しい順序。テーブル再作成からデータ再アップロードまでの間、公開側の moments タブは空になる（許容済み）。

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')

# 1. moments テーブルを再作成（既存データは再アップロードで復元するため捨てる）
mysql -h tidb.${TAILNET} -P 4000 -u root -p -e "DROP TABLE IF EXISTS blog_dev.moments"
sed 's/${SCHEMA}/blog_dev/g' tools/dsql-cli/dsl-tidb/schema/07_moments.sql | mysql -h tidb.${TAILNET} -P 4000 -u root -p

# prd も同様（リリース PR マージのタイミングに合わせて実施）
mysql -h tidb.${TAILNET} -P 4000 -u root -p -e "DROP TABLE IF EXISTS blog_prd.moments"
sed 's/${SCHEMA}/blog_prd/g' tools/dsql-cli/dsl-tidb/schema/07_moments.sql | mysql -h tidb.${TAILNET} -P 4000 -u root -p
```

2. リリース PR をマージ（admin-api / admin-web / blog-api / web が新版になる）
3. 管理画面から既存分を再アップロード（オリジナル写真から投稿し直すと EXIF の撮影時刻が入る）
4. DB ドキュメントを再生成: `docs/` で `bun run doc-gen`（moments.md に captured_at が反映される）

## 検証

```bash
# blog-api
cd apps/blog-api
cargo test --workspace     # 全 pass（カーソル往復のユニットテスト含む）

# admin-api
cd apps/admin-api
bun test                   # 全 pass（capturedAt 必須のスキーマテスト含む）

# リポジトリ全体
bun run lint
bun run spell-check
bun run type-check
```

## 注意点 / 残課題

- **EXIF のタイムゾーン**: `DateTimeOriginal` は TZ 情報を持たないため端末ローカル TZ で解釈する。海外で撮った写真は端末 TZ とのずれ分だけ時刻がずれる（個人ブログ用途として許容）
- **EXIF がない写真**（スクリーンショット、他アプリからの保存など）はファイル更新日時にフォールバックする。ダウンロード画像だと更新日時 = 保存日時になるので、フォームの取得元ラベル（EXIF / ファイル更新日時）で確認できる
- 公開 API のカーソル形式変更は互換性を壊すが、カーソルは opaque な受け渡しのみで永続化していない。CDN キャッシュ（max-age=60）中の旧カーソルは 400 になるが、web 側は追加読み込み失敗を静かに打ち切る実装のため実害なし
