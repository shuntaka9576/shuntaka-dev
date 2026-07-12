<!-- cspell:ignore jsdelivr woff gtag googletagmanager -->

# apps/web: フォント配信の最適化（HAR 分析: ウェイト削減 / 重複サブセット解消）

- 起票日: 2026-07-12
- 関連: [apps/web: エラーフォールバック起因の First Load JS 削減](../2026-07-12-web-error-fallback-bundle-size/index.md)（JS 側の削減。本エントリはフォント側）
- ステータス: 対応済み（2026-07-12。GTM は別件として未着手）

## 起票理由

本番トップページの HAR（Chrome DevTools で取得）を分析した結果、総転送量 約 1.07 MiB のうち **フォント (cdn.jsdelivr.net) が 561.5 KiB で全体の 52%** を占めていた。JS 共有チャンクの調査（関連エントリ）とは独立に、フォント配信だけで大きな削減余地がある。

## 調査結果（2026-07-12 時点、トップページ 1 ロード分）

### ドメイン別転送量

| 転送元                       | 転送量    | 割合 | 中身                                    |
| ---------------------------- | --------- | ---- | --------------------------------------- |
| cdn.jsdelivr.net（フォント） | 561.5 KiB | 52%  | ウェイト別 CSS ×5 + woff2 サブセット 22 |
| www.googletagmanager.com     | 279.7 KiB | 26%  | gtm.js (125 KiB) + gtag.js (162 KiB)    |
| shuntaka.dev（自前）         | 222.1 KiB | 21%  | Next.js チャンク + HTML                 |
| Clarity ほか                 | 約 30 KiB | 3%   |                                         |

### フォント内訳の問題点

Gen Interface JP を `layout.tsx` で 300/400/500/600/700 の 5 ウェイト分 `<link rel="stylesheet">` している（DESIGN.md の Weight ladder 仕様）。unicode-range サブセット化は効いているが、以下の無駄がある。

1. **700 は CSS（圧縮後 約 30 KiB）だけ読み込み、woff2 は 1 つも取得されていない**。700 は記事タイトルと `<strong>` 用なので、トップページでは CSS が丸ごと無駄になっている（記事ページでは使われる可能性あり。記事ページの HAR は未取得）
2. **300 と 400 で同じ unicode-range サブセットを二重取得**している。body が `--fw-light` (300)、記事タイトル等が 400 のため、同一サブセット（例: `119.woff2`）を 300 用 74.6 KiB + 400 用 73.4 KiB の両方でダウンロード
3. 取得された woff2 の重み別内訳: **400 ×17 ファイル、300 ×3、500 ×1、600 ×1、700 ×0**。500/600 の利用は僅か
4. ウェイト別 CSS 5 本（圧縮後 計約 150 KiB）が **render-blocking かつ外部 CDN 経由**でクリティカルパスに乗っている
5. variable font 版はパッケージに存在しない（`gen-interface-jp@0.1.7` は 100〜800 の static CSS + display 系のみ）→ 1 ファイル集約の選択肢はなし

### 再現手順

```sh
# HAR は Chrome DevTools > Network > Export HAR で取得
jq -r '.log.entries[] | [(.response._transferSize // 0), (.request.url | split("/")[2])] | @tsv' shuntaka.dev.har |
  awk '{sum[$2]+=$1; cnt[$2]++} END {for (d in sum) printf "%8.1f KiB  %2d req  %s\n", sum[d]/1024, cnt[d], d}' | sort -rn

# woff2 の重み別取得数
jq -r '.log.entries[] | select(.request.url | endswith(".woff2")) | .request.url | split("/w/normal/")[1]' shuntaka.dev.har |
  awk -F/ '{cnt[$1]++} END {for (w in cnt) print w": "cnt[w]}'
```

## 対応案（要ブランド判断）

DESIGN.md の Weight ladder（5 段階）はブランド仕様のため、どこまで削るかはデザイン判断が必要。効果順に:

1. **300/400 の統一**（約 100〜150 KiB 減）: body と記事系のどちらかに寄せ、重複サブセットを解消する。見た目が変わるため要判断
2. **500 または 600 の集約**（CSS 30 KiB + woff2 約 27 KiB 減）: 使用箇所が僅かなので、`--fw-medium` / `--fw-semibold` をどちらかに寄せる
3. **700 の遅延読み込みまたは削減**（トップで CSS 30 KiB 減): 記事ページ HAR を取ってから判断。bold → 600 への寄せも選択肢
4. **CSS の self-host**: render-blocking な外部 CDN 5 リクエストを自ドメイン配信にしてクリティカルパスから外す（woff2 は CDN のままで可）

## 実施内容（2026-07-12）

配信ウェイトを 400（text）/ 600（emphasis）の 2 本に集約し、CSS を self-host 化した。

- `apps/web/src/app/globals.css`: `--fw-light`/`--fw-regular` → 400、`--fw-medium`/`--fw-semibold`/`--fw-bold` → 600 に実値を寄せた（セマンティックトークンは維持）。Tailwind の `font-*` クラスも `@theme` の `--font-weight-*` 上書きで同じマッピングに統一
- `apps/web/src/app/layout.tsx`: `<link>` を 5 本の jsDelivr 直参照から self-host 2 本（`/fonts/gen-interface-jp/{400,600}.css`）に変更。woff2 は CDN のままのため `preconnect` は維持
- `apps/web/public/fonts/gen-interface-jp/{400,600}.css`: 下記コマンドでベンダリング（相対 URL の woff2 参照を CDN 絶対 URL に書き換え）
- `apps/web/.storybook/preview-head.html`: 本番と同じ self-host 2 本に変更（`staticDirs` の `public` から配信される）
- `apps/web/DESIGN.md`: Typography（5 weight ladder → 2 weight）と留意点のフォント記述を実態に同期

### フォント CSS の再生成手順（バージョン更新時）

```sh
cd apps/web
for w in 400 600; do
  curl -s "https://cdn.jsdelivr.net/npm/gen-interface-jp@0.1.7/${w}.css" |
    sed 's|url("./|url("https://cdn.jsdelivr.net/npm/gen-interface-jp@0.1.7/|g' \
    > "public/fonts/gen-interface-jp/${w}.css"
done
```

### 期待効果（トップページ、圧縮後）

- ウェイト別 CSS: 5 本 約 150 KiB → 2 本 約 60 KiB
- 300/400 の重複サブセット解消: 約 100 KiB 減（300 側の取得が消える）
- render-blocking CSS が自ドメイン配信になりクリティカルパスから外部 CDN が消える

## 備考

- GTM が gtm.js + gtag.js の 2 本で 279.7 KiB ある。GTM コンテナが GA4 のみなら gtag 直載せで約 125 KiB 減、残すなら `Script` の strategy を `lazyOnload` 化で初期表示の帯域競合を解消できる（フォントとは別件）
- DESIGN.md 162 行目に「`<link>` を 2 本（400 / 700）」とあるが実態は 5 本で記述が乖離している。対応時に修正する
