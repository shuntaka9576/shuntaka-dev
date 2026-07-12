<!-- cspell:ignore turbopack tmvtji gywtrp xvxhw cucl phro qlmanage -->

# apps/web: エラーフォールバック起因の First Load JS 削減（HashiBow 静的 SVG 化 + 記事ルート error.tsx 削除）

- 起票日: 2026-07-12
- 関連: `feat/error-fallback-bundle-size` ブランチ（bundle-size CI レポート整備）
- ステータス: 完了

## 起票理由

`TURBOPACK_STATS=1 bun run build` の計測（`.next/diagnostics/route-bundle-stats.json`、gzip 前）で全ルートの First Load JS が 560 KiB 超あり、ルート間の差が小さい（= 共有チャンクが支配的）。調査の結果、共有チャンク 576.7 KiB のうち約 89%（約 512 KiB）は react-dom + Next.js App Router ランタイムの固定費で userland からは削減できないが、アプリ側起因として次の 2 点が見つかった。

1. **HashiBow（約 23 KB のインライン SVG マスコット）が全ルートのクライアント JS に同梱されている**。`app/error.tsx`（`'use client'` エントリ）が `BaseLayout` + `ErrorFallback` → `HashiBow` を静的 import しているため、滅多に表示されないエラー UI が全ルートの First Load に 34.4 KiB 入っている（チャンクの 65% = 22.3 KiB が SVG パスデータ）
2. **記事ルートは同じ 34.4 KiB をほぼ丸ごと二重ダウンロードしている**。`[userName]/articles/[slug]/error.tsx` が root と同じ import を持ち、Turbopack がクライアントエントリごとにチャンクグループを作って共有モジュールを複製するため、内容がほぼ同一のチャンク（長い文字列リテラルの 102/103 が一致）が route 固有分として追加される

## 調査結果

### ルート別 First Load JS（2026-07-12 時点、gzip 前）

| ルート                        | First Load JS |
| ----------------------------- | ------------- |
| `/[userName]/articles/[slug]` | 626.5 KiB     |
| `/` , `/page/[page]`          | 603.5 KiB     |
| `/about`                      | 590.9 KiB     |
| `/_not-found`                 | 563.2 KiB     |
| ユニークチャンク合計          | 694.5 KiB     |

### 共有チャンクの内訳（全ルート共通 9 チャンク = 576.7 KiB）

| チャンク               | サイズ       | 中身（文字列シグネチャから特定）                                                                 |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `39tmvtji6sug0.js`     | 226.3 KiB    | react-dom 本体 + Flight client + Next ルーター断片                                               |
| `3lo6xk-xle5hd.js`     | 138.0 KiB    | Next App Router クライアントランタイム（prefetch / scroll restore / server-action）              |
| `27gywtrp1z5ef.js`     | 56.7 KiB     | react-dom 残部 + next/image クライアント側                                                       |
| `39xvxhw2cucl3.js`     | 54.6 KiB     | Next 共有ユーティリティ                                                                          |
| **`09phro5ju3clc.js`** | **34.4 KiB** | **アプリコード: ErrorFallback + BaseLayout 一式（うち 22.3 KiB が HashiBow の SVG パスデータ）** |
| `08737ep5_8k6w.js`     | 25.0 KiB     | react パッケージ + jsx-runtime                                                                   |
| `41mki-bgq2t7t.js`     | 21.5 KiB     | nprogress + Clarity + @vercel/analytics + speed-insights                                         |
| turbopack ランタイム   | 10.6 KiB     | 固定費                                                                                           |
| `15cn46ua6_2c-.js`     | 9.6 KiB      | アプリコード（layout 配下の Provider 類）                                                        |

記事ルートはこれに加えて `2b7b8i7kh_0_r.js`（34.4 KiB、`09phro5ju3clc.js` とほぼ同一内容）と route 固有チャンク（30.4 KiB）を読む。

### 原因のメカニズム

- `HashiBow` / `ErrorFallback` / `Button` 自体は `'use client'` なしのサーバー安全なコンポーネント。`error.tsx`（クライアントエントリ）から import されることでクライアントバンドル入りしている
- Turbopack は `'use client'` エントリごとにチャンクグループを作り、グループ間で共有モジュールを複製する。root の `app/error.tsx` と記事ルートの `error.tsx` が同じコンポーネント群を import しているため、同内容チャンクが 2 つできる
- `not-found.tsx` は RSC なので `ErrorFallback` を使っても JS には入らない（HTML に SVG がインライン展開されるだけ）。対応不要
- react-tweet（+swr）と tocbot はすでに dynamic import 済みで First Load 外。対応不要

## 設計方針

| 論点                       | 決定                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HashiBow の追い出し方      | インライン JSX SVG をやめ、`public/hashi-bow.svg` の静的ファイル + `<img>` 参照にする。`HashiBow.tsx` は `<img>` を返す薄いラッパーとして残し、呼び出し側（ErrorFallback / Storybook）は無変更                                                                                                              |
| `<img>` 化が成立する根拠   | HashiBow は hex 固定 6 色のみのフルカラー SVG。CSS 変数 / currentColor / テーマ依存 / インタラクションなし（DESIGN.md の「マスコットはフルカラー SVG」ルールとも整合）                                                                                                                                      |
| dynamic import 案の不採用  | `error.tsx` 側を `next/dynamic` にする案は、エラー発生時（= ネットワーク障害の可能性が高い場面）にチャンク fetch が必要になり本末転倒。静的 SVG なら画像が落ちてもテキストと再試行ボタンは即描画される                                                                                                      |
| オフライン時のデグレ       | 許容する。ユーザー回線断でエラー UI が出た場合のみ画像 fetch も失敗して alt 表示になるが、テキストと再試行ボタンは JS 同梱のため必ず描画される。blog-api 障害や JS ランタイムエラー（大半のケース）では回線は生きており画像は表示される。`<link rel="prefetch">` での先読みは転送量が復活するため採用しない |
| 記事ルート `error.tsx`     | 削除。root の `app/error.tsx` が同一 UI（BaseLayout + ErrorFallback）で受けるため、ユーザーから見た表示は変わらない                                                                                                                                                                                         |
| 記事ルート `loading.tsx`   | 残す。BaseLayout import による残差重複（約 11 KiB）が残るかはビルドで実測し、残る場合のみ対処を検討                                                                                                                                                                                                         |
| about ページの HashiMascot | スコープ外。マウス追従のインタラクティブ SVG（ソース 5.9 KB）で route 固有チャンク側にあり、共有チャンクを太らせていない                                                                                                                                                                                    |

## 実装フェーズ

- [x] Phase A: HashiBow の静的 SVG 化
- [x] Phase B: 記事ルート error.tsx の削除
- [x] Phase C: 計測・検証

### Phase A: HashiBow の静的 SVG 化

1. `src/components/HashiBow.tsx` の `<svg>` 要素を `apps/web/public/hashi-bow.svg` として書き出す
   - JSX 属性を SVG 属性に変換する: `fillRule` → `fill-rule`、`clipRule` → `clip-rule`
   - `width` / `height` / `className` / `role` / `aria-label` はファイル側に含めない（`viewBox="0 0 740 848"` と `xmlns` は残す）
2. `HashiBow.tsx` を `<img src="/hashi-bow.svg" width={width} height={height} className={className} alt="hashi" />` を返すだけの実装に書き換える。props インターフェース（`width` / `height` / `className`、デフォルト値 185×212）は維持する
3. 呼び出し側は無変更で動くことを確認する
   - `ErrorFallback`（139×159 指定）
   - `HashiBow.stories.tsx` / `ErrorFallback.stories.tsx`（Storybook は `.storybook/main.ts` の `staticDirs: ['../public']` 設定済みのため画像が解決される）

### Phase B: 記事ルート error.tsx の削除

1. `src/app/[userName]/articles/[slug]/error.tsx` を削除する
2. `src/app/error.stories.tsx` 冒頭の「記事エラーも同じ ErrorFallback を描画する」コメントを実態（記事ルート専用の error.tsx は削除済みで root が受ける）に合わせて更新する

挙動差分は次の 2 点のみで、表示は同一。

- `console.error` のプレフィックスが `Article error:` → `Application error:` になる
- エラー時の再レンダリング範囲がセグメント単位から root layout 直下全体になるが、フォールバック自体が BaseLayout を描画するため見た目は変わらない

### Phase C: 計測・検証

```bash
cd apps/web
bun run type-check
bun test src/
TURBOPACK_STATS=1 bun run build
jq '[.[] | {route, kib: (.firstLoadUncompressedJsBytes / 1024 * 10 | floor / 10)}]' \
  .next/diagnostics/route-bundle-stats.json
```

- 全ルートで約 −22 KiB、記事ルートはさらに重複チャンク分 −34 KiB になっていること（期待値は下表）
- 記事ルートの `firstLoadChunkPaths` から重複チャンク（旧 `2b7b8i7kh_0_r.js` 相当）が消えていること。34 KiB 級のチャンクが残っている場合は `loading.tsx` 由来の複製なので、`loading.tsx` から BaseLayout を外すか許容するかを判断する
- エラー UI の目視確認。dev サーバーは error overlay が出るため本番モード（`bun run build && bun run start`）で行う。記事ページのコンポーネントに一時的に `throw` を仕込むか、blog-api を止めて API エラーを発生させ、マスコット画像・テキスト・再試行ボタンの表示を確認する
- 存在しない URL で not-found ページのマスコット画像が表示されること
- Storybook（`bun run storybook`）で `Components/ErrorFallback` / `Components/HashiBow` / `Pages/Error` の各 story が表示されること
- bundle-size CI（`.github/actions/bundle-size`）のレポートで前後差分を確認する

## 削減量の見積もり

| ルート                        | 現状      | A+B 適用後（見込み） |
| ----------------------------- | --------- | -------------------- |
| `/[userName]/articles/[slug]` | 626.5 KiB | 約 570 KiB（−9%）    |
| `/` , `/page/[page]`          | 603.5 KiB | 約 581 KiB           |
| `/about`                      | 590.9 KiB | 約 569 KiB           |
| `/_not-found`                 | 563.2 KiB | 約 541 KiB           |
| ユニークチャンク合計          | 694.5 KiB | 約 638 KiB           |

gzip 後の実転送量ベースでは 1 ルートあたり −7 KiB 程度。数値の主目的は「エラー UI という低頻度パスのコードを全ルートの初期ロードから外す」構造改善で、bundle-size CI の回帰検知の基準線も下がる。

## 注意点 / 残課題

- `loading.tsx` の BaseLayout import による重複チャンクは実測の結果**発生しなかった**（記事ルートに 34 KiB 級チャンクの残存なし）
- 記事ルートのエラーが root バウンダリで受かることの自動テストはない。エラーバウンダリを強制発火させる手動確認は未実施（dev API が到達可能で 404 → not-found にしかならず、`NEXT_PUBLIC_API_URL` はビルド時インライン化のためランタイム上書きで API 障害を再現できない）。フォールバック UI 自体は同一構成（BaseLayout + ErrorFallback + `<img>`）の 404 ページ実機確認でカバー
- 今回スコープ外の削減候補（優先度低）
  - アナリティクス系チャンク 21.5 KiB（nprogress + Clarity + @vercel/analytics + speed-insights）の遅延化。gzip 後の実益が約 7 KiB と小さく、計測タイミングへの影響と引き換えになる
  - `/` ルートの FloatingTagFilter / TagFilterTree の dynamic 化（−10〜15 KiB 見込み）。初期表示 UI のため CLS と相談
- 共有チャンクの約 89% は react-dom + Next ランタイムの固定費であり、これ以上の大幅削減は Next 側のバージョンアップ待ち

## 作業ログ

### 2026-07-12

- バンドル調査を実施。共有チャンクの内訳特定（フレームワーク固定費 89%）、HashiBow のクライアント JS 混入と記事ルートの重複チャンクを発見し、本タスクを起票
- Phase A/B を実装
  - `public/hashi-bow.svg` を `HashiBow.tsx` から機械変換で生成（`fillRule` → `fill-rule` 等）し、qlmanage でレンダリング結果を目視確認
  - `HashiBow.tsx` を `<img src="/hashi-bow.svg">` の薄いラッパーに書き換え（props 互換維持）
  - 記事ルートの `error.tsx` を削除、`error.stories.tsx` のコメントを更新
- Phase C 計測結果（`TURBOPACK_STATS=1 bun run build`、gzip 前）。見積もりとほぼ一致

  | ルート                        | 前        | 後        | 削減      |
  | ----------------------------- | --------- | --------- | --------- |
  | `/[userName]/articles/[slug]` | 626.5 KiB | 570.7 KiB | −55.8 KiB |
  | `/` , `/page/[page]`          | 603.5 KiB | 581.3 KiB | −22.2 KiB |
  | `/about`                      | 590.9 KiB | 568.7 KiB | −22.2 KiB |
  | `/_not-found`                 | 563.2 KiB | 541.0 KiB | −22.2 KiB |
  | ユニークチャンク合計          | 694.5 KiB | 638 KiB   | −56.5 KiB |
  - エラーバウンダリ由来チャンクは 34.4 KiB → 11.8 KiB に縮小、記事ルートの重複チャンクは完全に消滅（`loading.tsx` 由来の残差重複も発生せず）
  - SVG パスデータが全 JS チャンクから消えたことを grep で確認
  - 本番モード（`next start`）で 404 ページに `<img src="/hashi-bow.svg">` とテキストが描画され、`/hashi-bow.svg` が 200 で配信されることを確認
  - `type-check` / `bun test` / `bun run lint`（repo 全体）すべて pass
