<!-- cspell:ignore tocbot backfill -->

# 目次の刷新（tocbot 撤去）+ 見出しアンカー（# リンクコピー）追加

- 起票日: 2026-07-22
- 対象: `apps/web`, `apps/blog-api/markdown`, `tools/content-html-backfill`
- ステータス: 対応済み（prd の backfill のみ残）

## 起票理由

目次まわりに複数の問題が重なっていた。

1. **目次のインデントが分かりにくい**: tocbot が生成する入れ子 `ol` の左パディングを Tailwind preflight がリセットしており、階層の違いがマーカーサイズ（8px/6px/4px）でしか表現されていなかった
2. **hash 付き URL での自動スクロールが機能しない**: `ArticleContent` の初期 hash スクロール処理が `location.hash`（パーセントエンコード済み）をデコードせずに `getElementById` へ渡しており、日本語見出し ID では常に `null`。普段はブラウザネイティブのフラグメントスクロールが隠していたが、ロード完了後にコンテンツがストリーミングされるケースで露見する
3. **目次クリック後にハイライトが外れる**: tocbot の `updateToc` が `location.hash`（エンコード済み）と DOM の `href`（未エンコード）を比較するため、日本語 ID では照合に失敗し、クリック直後のスクロールイベントでアクティブ表示が全部剥がれる（本番で再現確認済み）
4. **モバイルで目次が出ない**: 1024px 以下は `right-sidebar` ごと `display: none` だった
5. **ローカル（dev DB）で目次リンクが `#heading-N` になる**: dev DB の `content_html` が旧コンバータ（見出し ID 生成なし）時代の保存値のままで、フロントのフォールバック ID が振られていた。コード差ではなく保存データの世代差
6. **見出しリンクのコピー手段がない**: 見出し先頭に `#` を置き、クリックで共有用 URL をコピーしたい

## 設計方針

| 論点                     | 決定                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tocbot の扱い            | 撤去して自前実装（約 120 行）。日本語 ID の encode/decode バグ・singleton 制約（モバイル用に DOM 複製が必要）・`window.onhashchange` 等のグローバル上書きが理由                                                                                                                                                                              |
| アクティブ追従           | rAF スロットルの scroll リスナーで「オフセット 100px を越えた最後の見出し」を選択。ページ最下部ではデコード済み hash の見出しを優先（スクロール到達不能な見出し対策）                                                                                                                                                                        |
| モバイル目次             | 1024px 以下は右上に sticky 固定した「目次」ボタン（`right-sidebar` を `display: contents` にして `.article-body` 基準で貼り付け）。タップで native `<dialog>` をボタン直下に表示し、項目タップ・背景タップで閉じる。`showModal()` の自動フォーカスがリンクに当たるとリングが下線に見えるため、`tabindex="-1"` のリスト全体へフォーカスを移す |
| 階層の表現               | ファイルツリー風の連続罫線（角丸 L 字コネクタ）を CSS で描画。`├──` などの文字だと行間 1.7 で縦線が途切れて見えるため文字は使わない                                                                                                                                                                                                          |
| 見出しアンカーの実装場所 | markdown クレート（Rust）の後処理で `<a class="heading-anchor" href="#id">#</a>` を見出し先頭に挿入。コピー動作はフロント（`ArticleContent`）で実装                                                                                                                                                                                          |
| コピーの挙動             | クリックで `preventDefault` → `history.pushState` で hash のみ更新（ジャンプなし）→ エンコード済み絶対 URL をクリップボードへ → `Copied!` フロート表示                                                                                                                                                                                       |
| 既存記事への反映         | `tools/content-html-backfill` を `--all` で実行して `content_html` を再生成（`updated_at` は変わらない）                                                                                                                                                                                                                                     |

## 実装フェーズ

- [x] Phase A: 目次インデントの CSS 改善（階層ごとの段下げ）
- [x] Phase B: `ArticleContent` の hash デコード修正
- [x] Phase C: tocbot 撤去 → 自前 TOC（デスクトップ追従 + モバイルアコーディオン）
- [x] Phase D: 見出しアンカー（Rust 後処理 + フロントのコピー処理 + CSS）
- [x] Phase E: Storybook フィクスチャ再生成・検証
- [x] Phase F: dev DB へ backfill 実行
- [ ] Phase G: API デプロイ後、prd へ backfill 実行

## backfill 手順

markdown クレート変更を含む API を**デプロイした後**に実行する（保存値と API 生成値の世代を揃えるため）。

```sh
cd tools/content-html-backfill

# wasm を最新のコンバータでビルド
bun run build:wasm

TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')

# dry-run で差分件数を確認（新規 / 一致 / 差分あり）
bun run backfill -- --endpoint "mysql://root@tidb.${TAILNET}:4000/blog_dev" --all --dry-run

# 実行（一致はスキップされる）
bun run backfill -- --endpoint "mysql://root@tidb.${TAILNET}:4000/blog_dev" --all
```

prd は endpoint の database を `blog_prd` に変えて同じ手順。

## 作業ログ

### 2026-07-22

- 目次インデント改善: `.toc ol ol a` / `.toc ol ol ol a` に段下げを追加（Tailwind preflight が `ol` の padding を消すため明示指定）
- hash スクロール不全の原因特定: `location.hash` はエンコード済みで返る。`decodeURIComponent` を挟んで修正
- tocbot のハイライト剥がれを本番で再現（下部見出しクリック → 150ms 後に `is-active-li` が全消失）。tocbot 内部の `updateToc` がエンコード済み hash と未エンコード href を比較しているのが原因で、修正不能と判断し撤去
- `TableOfContents` を自前実装に置換。tocbot を `package.json` から削除
- 見出しアンカーを `add_heading_anchors`（markdown クレートの後処理）として実装。comrak が見出し末尾に付ける空の `a.anchor` はそのまま残している（不可視・無害）
- Storybook フィクスチャを `cargo run -p markdown --example storybook_fixture` で再生成
- dev DB へ backfill 実行: 134 件処理（更新 100 / 一致スキップ 34 / 失敗 0）。dev で目次リンクが `#heading-N` になっていた問題はこれで解消（旧コンバータ世代の保存値に見出し ID が無かったのが原因）
- モバイル目次を上部 sticky 固定に変更。`position: sticky` の基準を記事全体を含む `.article-body` に取らせるため、ラッパー `.right-sidebar` を `display: contents` で消す方式にした
- モバイル目次をアコーディオンから「右上固定の目次ボタン + ボタン直下のモーダル（native `<dialog>`）」へ変更。`showModal()` が最初のリンクへ自動フォーカスしてリングが全幅の下線に見えるバグは、`tabindex="-1"` のリスト全体へフォーカスを移して解消
- 目次の階層表現を四角マーカー + 縦レールからファイルツリー風の連続罫線（角丸 L 字コネクタ、CSS 描画）へ変更。`├──` 文字案は行間で縦線が途切れるため不採用。レールが最後の項目より下へはみ出す問題もレール廃止で解消
