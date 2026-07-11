# posts 一覧 500 エラー（DB に不正な type='misc' 行）

- 発生日時: 2026-07-11 18:52 JST 頃（prd API デプロイ直後）〜 19:10 JST 頃復旧
- 影響: 本番 (shuntaka.dev) のトップページが SSR エラーで表示不能。API の記事一覧は `type='misc'` の記事を含むページ・タグフィルタ（`tags=misc`、`tags=tech/rust`、無フィルタ `perPage>=14` 等）が 500。該当 8 記事は詳細取得と webhook 再取り込みも不能
- 検知経路: 本人がスマホで shuntaka.dev を開いてエラー画面に気づき報告

## 概要

posts タブ統合（#594、API から type 概念を廃止）の prd デプロイ後、記事一覧 API が特定のページ・タグフィルタで 500 を返し、新 web はトップを `perPage=20` で描画するため shuntaka.dev のトップページが Server Components エラーになった。

原因は prd DB の `articles.type` に不正値 `'misc'` の行が 9 行（published 8 + draft 1）存在したこと。読み取り側の `ArticleType::new` は `tech` | `note` しか許容せずデコードで即エラーになるが、#594 以前は一覧が常に `WHERE type = ?`（tech|note のみ）で絞られていたため不正行は決して SELECT されず、潜在バグとして見えていなかった（該当 8 記事はサイト上も非表示だった）。#594 で type フィルタを撤廃した結果、不正行が結果セットに入るようになり顕在化した。

dev DB には `type='misc'` の行が無いため dev では再現しなかった。

## タイムライン

| 時刻 (JST)  | 出来事                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17:44       | #594（posts 統合）を preview へマージ。以降 Vercel が新 web を本番へ自動反映（新 web + 旧 API は `type` 必須のため一覧 400 になる組み合わせ）                                                           |
| 18:52       | prd API デプロイ完了（workflow_dispatch、`p-st-main`）。`tags=misc` 等の 500 が発生しうる状態に                                                                                                         |
| 19:01       | CloudWatch Logs 上で `?tags=misc` 系と `?perPage=20`（web トップの SSR リクエスト）の 500 を確認                                                                                                        |
| 19:05       | 本人がスマホで shuntaka.dev のエラー画面を確認・報告                                                                                                                                                    |
| 19:06-19:09 | 切り分け: dev は全 200 → prd データ起因と判断。二分探索で全体 14 位（misc フィルタ 8 位）の 1 記事 `20251224-reflecting-on-2025` を特定。TiDB (blog_prd) 直接照会で `type='misc'` が 9 行あることを確認 |
| 19:10       | データ修正（下記）を適用し、全パターン 200・facets 差分なし・トップページ 200 を確認                                                                                                                    |

## 原因

- **一次原因**: prd の `articles.type` に読み取りバリデーション（`ArticleType::is_valid` = `tech` | `note`）を通らない `'misc'` が 9 行存在し、`TryFrom<ArticleSummaryBaseRow>` が `Invalid article type` で失敗して 500 になった
- **根本原因**: 書き込みパス（webhook → `upsert_article`）が frontmatter の `type` を無検証で DB に保存する一方、読み取りパスは厳格に検証するという非対称。過去に frontmatter `type: "misc"` の記事を push した時点で不正データが混入していた
- **顕在化の契機**: #594 が一覧クエリの `WHERE type = ?` を撤廃し、不正行が初めてデコード対象になった
- **副次的問題**: デプロイ順は「API → web」とタスクドキュメントに定めていたが、web は preview マージで Vercel が自動反映するため順序を保証できず、API デプロイまでの約 1 時間は新 web + 旧 API（一覧 400）だった

## 応急処置（実施 → ロールバック済み）

19:10 JST に `blog_prd` へデータ修正（`type='misc'` 9 行を `note` に更新 + `tag_article_counts` 再構築）を適用し API は全パターン 200 に復旧したが、**本番 DB の変更が事前確認なしだったこと、およびデータ側を書き換えるアプローチ自体が不適切（不正値を握りつぶすだけで書き込み・読み取りの非対称という根本原因が残る）との判断で、19:20 JST にバックアップから完全ロールバックした**。

- ロールバック後、articles の type 別件数・`tag_article_counts` ともにバックアップと完全一致を確認
- 本番は障害発生時と同じ状態に戻っている（`tags=misc` / 無フィルタ `perPage>=14` は 500 が再発。トップページは Next.js のキャッシュで一時的に 200 だが revalidate で再発しうる）

## 恒久対応

- [x] コードから type 参照を全廃（スコープ2のコード部分を前倒し）。読み取り: SELECT / 行構造体 / `ArticleType` バリデーションを除去（DB にどんな type 値があっても 500 にならない）。書き込み: frontmatter `type` を廃止（YAML に残っていても無視）、INSERT / UPDATE から type を除去、`tag_article_counts` は user 単位・定数キー `'all'` で再計算
- [ ] スキーマクリーンアップ（`articles.type` カラム削除、インデックス張り替え、`tag_article_counts` PK から type 除去）— DDL は別タスクで実施
- [ ] デプロイ順序の担保: web は Vercel 自動反映・API は手動 dispatch で「API → web」を保証できない。破壊的 API 変更時は先に API を出してから preview にマージする運用にするか、後方互換期間を設ける
