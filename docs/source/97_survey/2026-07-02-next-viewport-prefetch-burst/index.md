<!-- cspell:ignore dedup -->

# 記事一覧の viewport prefetch 一斉発火による体感遅延

- 対象: apps/web (Next.js 16.2.9 / App Router, Vercel dev 環境)
- 調査日: 2026-07-02
- 関連: [TiDB 記事詳細クエリの実行プラン](../2026-06-30-tidb-article-detail-explain-plan/index.md)

dev 環境で記事一覧ページが 10 記事程度でも遅く感じる事象。原因は viewport prefetch の一斉発火と、prefetch 1 本あたりのバックエンドコストの掛け算だった。フロント側の対処として ProgressLink を intent-based prefetch（hover / touch 時のみ単発発火）に変更した。

## 事象と構造

- 記事カード・ページネーション・nav タブは `ProgressLink` 経由の `next/link` で、`prefetch` prop は未指定 = デフォルトの viewport prefetch が有効だった
- 一覧ページを開くと viewport 内の 12〜14 URL（記事 10 + ページネーション + タブ）が prefetch キューに積まれる
- 記事詳細は `revalidate = 30` の ISR + `generateStaticParams` 空 = キャッシュ miss 時に blog-api Lambda がフルレンダリング
- blog-api の詳細エンドポイントはリクエスト毎に Markdown→HTML 変換を実行する（DB に content_html を持たない）ため 1 本が重い
- dev 環境はデプロイ頻度が高くトラフィックが少ないので ISR キャッシュがほぼ常に空 = 最悪パスを毎回踏む

## next 16.2.9 の prefetch 内部実装

prefetch は完全並列でも完全直列でもなく、優先度付きキューで同時実行数が絞られている。segment cache の scheduler 実装（`next/dist/client/components/segment-cache/scheduler.js`）より:

```js
if (task.priority === _types.PrefetchPriority.Intent) {
  // The most recently hovered link is allowed to exceed the default limit.
  return inProgressRequests < 12;
}
// The default limit is lower than the limit for a hovered link.
return inProgressRequests < 4;
```

- viewport 由来の prefetch: **同時 4 本まで**
- hover（Intent）由来: 優先扱いで同時 12 本まで

つまり 12〜14 URL は 4 並列 × 順番待ちで流れる。1 レスポンスが数秒かかる dev 環境ではキューが数十秒単位で流れ続け、その間の実ナビゲーションが prefetch と Lambda・帯域を奪い合う。

また App Router の `prefetch={false}` は **hover でも自動 prefetch しない**（Pages Router と挙動が異なる。`link.d.ts` の型コメントに明記）。hover prefetch が欲しい場合は `useRouter().prefetch()` の手動呼び出しが必要。

## 対処（実施済み）

### `src/components/ProgressLink.tsx` — intent-based prefetch 化

- `prefetch = false` をデフォルトで destructure し `<Link prefetch={prefetch}>` に明示的に渡す。呼び出し側が `prefetch="auto"` 等を渡せば従来挙動に戻る
- `onMouseEnter` / `onTouchStart` で `router.prefetch(href)` を単発発火。`useRef` でインスタンス単位の dedup
- `onFocus` は付けない（next 16 の `InternalLinkProps` に存在せず型エラーになる）
- `unstable_dynamicOnHover` prop は不採用（unstable かつ FULL prefetch になり過剰）

### `src/components/Footer.tsx`

`next/link` を直接 import しているのは ProgressLink と Footer の 2 ファイルのみ。Footer の `/` リンクに `prefetch={false}` を追加。

## 検証結果（ローカル production ビルド + dev API 実測）

`NEXT_PUBLIC_API_URL=https://api.shuntaka.tech bun run build && bun run start` で起動し、Chrome の Network（`?_rsc=` フィルタ）で確認。

| 操作                  | 結果                                                               |
| --------------------- | ------------------------------------------------------------------ |
| 一覧ページ表示後 5 秒 | `_rsc` prefetch 0 件（修正前は 12〜14 URL が一斉発火）             |
| 記事カード hover      | 該当記事のみ prefetch 発火                                         |
| 同じカードに再 hover  | 追加リクエストなし（dedup）                                        |
| 別カードに hover      | 該当記事のみ。共有レイアウトのセグメントはキャッシュ再利用で本数減 |
| カードをクリック      | prefetch 済みキャッシュで即遷移、プログレスバー表示も従来どおり    |

補足: next 16 は segment cache 方式のため、hover 1 回で `?_rsc=` リクエストがセグメント単位（route tree / layout / page / metadata）で数本飛ぶ。これは 1 記事分の分割取得であり正常。

検証時の注意: `.env.local` の `NEXT_PUBLIC_USER_NAME` が dev API に存在しないユーザーだと一覧が空になる。`NEXT_PUBLIC_*` はビルド時にインライン化されるため、上書きはランタイムではなく **ビルド時** に環境変数で行う必要がある。

## 見送った対応と根拠

- **`revalidate = 30` の延長**: Vercel の ISR は stale-while-revalidate で動くため、期限切れでも CDN が stale を即返して裏で再生成する。遅いのはキャッシュが完全に空の初回のみで、延長しても解消せず記事更新の反映が遅れるだけ。現状維持
- **`/page/[page]` の probe fetch**: `ArticleListView` 内の fetch と URL・オプションが同一のため Request Memoization で 1 回に dedup 済み。実害なし
- **`generateStaticParams`（空配列）**: 意図的なオンデマンド生成方針のため維持。デプロイ直後の初回 miss まで潰したくなったらビルド時生成か on-demand revalidation を検討

## 残課題（別タスク推奨）

prefetch を止めても詳細ページ 1 リクエスト自体の重さは残っている。

- `apps/blog-api/markdown/src/lib.rs` の `highlight_code` が **コードブロック毎に** `SyntaxSet::load_defaults_newlines()` / `ThemeSet::load_defaults()` をロードしている。`LazyLock` 化で変換コストを大きく削れる
- OGP リンクカード / GitHub embed が変換中に同期外部 HTTP fetch（タイムアウト 5 秒 × URL 数、squid プロキシ経由）を行う。キャッシュか保存時変換（content_html の永続化）を検討
