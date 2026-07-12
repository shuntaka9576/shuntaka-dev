# logs 機能（180字 + 写真必須の一文投稿）の構想と UI モック

- 起票日: 2026-07-12
- 関連: [tech / note タブの posts 統合](../2026-07-11-posts-tab-unification/index.md)
- ステータス: UI モック（Storybook）完了。API / 管理画面 / インフラ設計は未着手

## 起票理由

従来の posts（記事）とは別に、**log** という軽量な投稿の概念を作る。Web アプリのタブ（posts / logs / about）で切り替えられる新しいセクション。

- **180 文字以内**の一文 + **画像必須**（posts と逆で、写真が主役）
- 一覧はページネーションではなく**無限スクロール**
- 投稿は公開 UI からではなく、別途作る**管理画面**（admin.shuntaka.dev）から行う
- モバイルで撮った写真を圧縮してアップロードし、閲覧できるところまでが最終ゴール

## UI モック（Storybook）

`apps/web` に閲覧側のコンポーネントを追加した。`bun run storybook` の `Components/LogCard` / `Components/LogFeed` で確認できる。

コンセプトは「壁に貼られた写真」。ポラロイド風フレーム（下帯に日付）の写真が 2 度前後の傾きを偶奇で交互につけて並び、右に一文を添える。写真は留め具で壁に留められている。

| コンポーネント | 内容                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LogCard`      | 左に留め具付きポラロイド風写真、右に一文。hover で留め具を支点に減衰振り子でふわっと揺れる（`prefers-reduced-motion` では無効）                                                                                                                                                                                                                                          |
| 留め具         | `fastener`: `clip`（木製洗濯バサミ、デフォルト） / `tape`（マスキングテープ）。`fastenerColor`（pink / blue / yellow / green）は tape で有効。**投稿ごとに管理画面で選ぶ想定**。丸画鋲案は「実物感が出ない」、台形シルエットの短躯クリップ案も「実物と形が違う」ため廃案。実物写真を参照した縦長の直線シルエット + 明るい松系の木肌 + 右にループが垂れる金属バネに再設計 |
| `LogFeed`      | `IntersectionObserver` の番兵による無限スクロール。読み込み中はポラロイド形のスケルトン、末尾到達で ochaIcon が静かに締める。`role="feed"` / `aria-busy` 付き                                                                                                                                                                                                            |
| Story          | `LogCard/FastenerVariants`（留め具比較）、`LogCard/TapeColors`（テープ色）、`LogFeed/LogsPage`（posts / logs / about タブ込みのページ全体）、`LogCard/MaxLength`（上限ちょうど 180 文字）                                                                                                                                                                                |

モック写真は Unsplash（square crop URL）を使用。当初 picsum.photos を使ったが、Chrome から fastly CDN への接続が不安定で白画像になったため差し替えた。

デザインシステムとの差分（意図的な例外。本実装時に `DESIGN.md` へ明記する）:

- hover の「1 プロパティ 1 段階」ルールから外れ、留め具を支点にした揺れアニメーションを許容（logs は写真が主役の情緒的なサーフェスとして）
- 留め具は「現実にある物の描写」としてグラデーション・落ち影・多色（木肌 + 金属バネ等）を許容。UI サーフェスのグラデ禁止 / 静止カード影禁止は従来どおり
- カード自体はフラット（影は hover 時の `--shadow-2` のみ）。アクセント色は未使用

## システム構成

当初は「UI = Cloudflare Workers、画像 = R2、API = 共用 api.shuntaka.dev」を検討したが、Workers custom domain に DNS ゾーン移管が必要なため **廃案**。CloudFront ベースのオール AWS 構成（admin.shuntaka.dev = CloudFront + S3/Lambda Function URL、認証 = Cognito SRP、ORM = Kysely）に決定した。詳細は [logs 管理画面のアーキテクチャ決定と実装計画](../2026-07-12-logs-admin-architecture/index.md) を参照。

## 未決事項

- 留め具のデフォルト / 最終ラインナップ（現状 clip / tape の 2 種 + テープ 4 色。Storybook の `FastenerVariants` で比較中）
- タブ追加時の `BaseLayout` 拡張（`currentTab` union に `'logs'` を追加）と `/logs` ルート（実装フェーズは管理画面計画のフェーズ 4）
