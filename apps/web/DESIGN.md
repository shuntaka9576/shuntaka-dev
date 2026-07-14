# shuntaka.dev デザインシステム

**shuntaka.dev**（髙橋俊一 / shuntaka による、読み物中心の静かな日本語テックブログ）のデザインシステム。ブランドは 1 つのマスコット **抹茶カップ (ochaIcon)**、1 色のアクセント **マゼンタピンク (`--color-accent`)**、そして GitHub-Dark 風のダークモードで構成される。

## 仕様の出どころ

- **Source of truth** — このファイル（ルール + voice）と `src/app/globals.css`（トークン実装）。
- **視覚カタログ** — `apps/web/.storybook/`（`bun run storybook` で起動）。`main` マージで GitHub Pages に自動デプロイ。
- **Figma**（`shuntaka.dev.fig`）— ロゴ検討、シェアボタン OGP、MacBook Pro 一覧ビュー、検索 / タグビュー、Timeline 読書履歴ウィジェットなどの初期コンセプト。Figma は _コンセプト精度_ であり、衝突した場合はコードベースが正。

## ブランドコンテキスト

shuntaka.dev は、日本人ソフトウェアエンジニアの個人テックブログ。**posts**、**moments**、**about** の 3 セクション構成（記事の分類はタグ階層 `tech/` / `misc/` が担う。moments は 180 字 + 写真必須の一文投稿）で、記事は Markdown で書かれサーバーサイド（Rust + comrak + syntect）で HTML に変換される。読書体験で重視するのは：

- 派手な装飾より **長文の読みやすさ**
- 写真ではなく **コードブロック・リンクカード・埋め込み** を視覚の中心に
- マゼンタというただ 1 つの落ち着いたアクセント色（ブランドマークまたはフォーカス状態のみで使用）

---

## ビジュアル基盤

### Color

- **Light:** ページ背景は `--color-bg`（オフホワイト）、サーフェスは `--color-surface`、ヘッダーなど持ち上げ面は `--color-surface-raised`。本文テキストは `--color-text`（暖色寄りダークグレー、純黒では **ない**）。
- **Dark:** GitHub-Dark 系のネイビー。同じ `--color-*` トークンを `[data-theme='dark']` で上書きする。実値は `globals.css` を参照。
- **Accent:** **マゼンタピンク (`--color-accent`)**。用途：ダークモードトグル ON のトラック、NProgress バー、focus-visible アウトライン、danger callout のボーダー。本文テキストには **絶対** 使わない、カードの fill にも **絶対** 使わない。
- **Borders:** 一般用途は `--color-border`、記事リスト下線は `--color-border-subtle`（ほぼ見えない、タイポグラフィのベースライン的な存在）。

### Typography

- **本文 / 見出し:** [Gen Interface JP](https://gen.typesetting.jp/)（400 / 600 の 2 weight 配信）。Inter（欧文）と Noto Sans JP（和文）を合成した OFL ライセンスの UI 書体で、欧文と和文を 1 ファミリーで賄う。CSS は self-host（`public/fonts/gen-interface-jp/{400,600}.css`。woff2 の URL は jsDelivr CDN に書き換え済み）で、Google Fonts と同じ unicode-range サブセット化により必要な woff2 だけが動的にロードされる。CSS 上は `font-family: 'Gen Interface JP', …` として参照。配信ウェイトを 2 本に絞った経緯は `docs/source/98_tasks/2026-07-12-web-font-delivery-optimization` を参照（旧 5 weight 時代はフォントだけでページ転送量の 52% を占めていた）。
- **Mono:** システムスタック（`ui-monospace, SFMono-Regular, …`）。
- **スケール.** 9 段階の `--fs-display` / `--fs-h1` / `--fs-h2` / `--fs-h3` / `--fs-h4` / `--fs-body-lg` / `--fs-body` / `--fs-caption` / `--fs-code`。実値は `globals.css` と Storybook `Design System/Tokens` を参照。
- **Weight ladder.** 実配信は 400（text）/ 600（emphasis）の 2 段階。セマンティックトークンは 5 つのまま維持し、実値をどちらかに寄せている（`--fw-light` / `--fw-regular` → 400、`--fw-medium` / `--fw-semibold` / `--fw-bold` → 600。Tailwind の `font-*` クラスも `globals.css` の `@theme` で同じ値に上書き済み）。要素ごとの割り当ては以下:

  | 要素                                                                                                                               | Weight         |
  | ---------------------------------------------------------------------------------------------------------------------------------- | -------------- |
  | body / `.prose p` / `.prose li` / `.prose blockquote` / `.prose code` / nav タブ / 一覧の日付 / `.prose h3`〜`h6` / 一覧のタイトル | 400 (text)     |
  | `.prose h1`, `.prose h2` / Button / `.link-card-title` / ロゴ「shuntaka.dev」 / `.article-title` / `strong`                        | 600 (emphasis) |

  ウェイトの段階は最小限に抑え、階層はサイズ（`--fs-*`）と色で立ち上げる。font-weight は数値リテラルではなく必ず `var(--fw-*)` または対応する Tailwind の `font-*` クラスで参照する（実値を 400/600 以外に増やさない）。

- **行高.** 本文 `--lh-body`（読書体験のため大きめ）。見出し `--lh-heading`。リスト `--lh-list`。
- **`em` と `px` を混ぜない.** タイポは `rem`、レイアウトは `px` またはレイアウトトークン。
- **強調は `<strong>` のみ.** 着色強調・全大文字・letter-spacing いじりはしない。

### ラベル / 表記

- **大文字小文字.** タブラベルとサイトタイトルは小文字（`posts`, `moments`, `about`, `shuntaka.dev`）。記事内見出しを Title Case にしない。
- **日付.** 常に `YYYY/MM/DD`（例: `2021/03/12`）。記事タイムスタンプは `MM/DD HH:mm YYYY`。moments の写真下のみ曜日 + 撮影時刻付き（`YYYY/MM/DD(月) HH:mm`）。
- **絵文字.** プロダクト UI に絵文字を入れない。あたたかみはマスコット (`ochaIcon`、フルカラー SVG) が担う。

### タグ

- ハッシュ前置き（`#NestJS`, `#Rust`）。
- 形状: 角丸長方形、1px ボーダー、塗りなし。

### 背景

- **画像なし.** ヒーロー写真・全画面グラデーション・パターン・グレインはなし。サーフェスはフラットな `--color-surface`（light / dark どちらも同様にフラット）。
- **グラデーション禁止.** "rainbow gradients, neon shadows" は明示的に拒絶される。
- **記事ラッパー** はフラットなサーフェスパネル、コーナー半径 `--radius-lg`、subtle な 1px ボーダー。

### ボーダー / 角

- **半径は 4 段階.** `--radius-sm`（ボタン、タグ）、`--radius-md`（カード、サムネイル）、`--radius-lg`（記事ラッパー）、`--radius-full`（トグル、円形アイコン）。
- **ボーダーは 1px solid のみ.** 色は通常 `--color-border` または `--color-border-subtle`。double / dashed なし。

### 影 / elevation

- 本番 CSS で実際に使う影は `link-card:hover` の `--shadow-2` と、フローティングタグ UI（トリガー `--shadow-2` / ポップオーバーパネル `--shadow-3`）のみ。
- 4 段階の elevation トークン（`--shadow-0`…`--shadow-3`）のうち残りはモーダル用に予約。
- **静止状態のカードに drop-shadow を追加しない.** システムは flat-by-default で読まれる。

### Motion

- **トークン:** `--motion-fast` / `--motion-base` / `--motion-slow`（実値は `globals.css` 参照）。easing はブラウザデフォルト（linear / ease）。
- **用途:** copy ボタンの opacity（`0.4 → 1.0`）、link-card の border-color と shadow、NProgress バー。
- **bounce / spring / ページロード時のエントランスアニメーションなし.** ブログは「即座に表示される」感じを目指す。

### Hover / press / focus

- **Hover.** 1 つのプロパティを 1 段階だけ変える — ボタンは `filter: brightness(95%)`、リンクカードは border-color を入れ替える程度。
- **Focus-visible.** 全要素共通の `outline: 2px solid var(--color-accent); outline-offset: 2px;` を `globals.css` で `a`、`button`、`[role="button"]`、input、summary に当てる。アクセシビリティの基盤。
- **Active.** ボタンは `filter: brightness(90%)`。
- **Disabled.** `opacity: 0.5; pointer-events: none;` + `aria-disabled="true"`。

### moments の意図的例外

moments（180 字 + 写真必須の一文投稿）は写真が主役の情緒的なサーフェスとして、`MomentCard` / `MomentFeed` に限り以下だけ基本ルールから意図的に外れる：

- **揺れアニメーション.** hover の「1 プロパティを 1 段階」から外れ、留め具を支点にした減衰振り子で写真がふわっと揺れる（`moment-swing`）。`prefers-reduced-motion` では無効。
- **留め具の実物描写.** 木製クリップ / マスキングテープは「UI サーフェスではなく現実にある物の描写」として、グラデーション・落ち影・多色（木肌 + 金属バネ等）を許容する。
- 上記以外は従来どおり：カード自体はフラット（影は hover 時の `--shadow-2` のみ）、UI サーフェスのグラデーション禁止・静止カードの drop-shadow 禁止は維持、アクセント色は使わない。

### レイアウトルール

- 外側は `--layout-max` の単一カラム中央寄せ。記事一覧・about は `BaseLayout` の `narrow` でヘッダー・タブ行・本文を `--layout-list-max` の中央カラムに揃える（ロゴと一覧の左端が一致する）。
- タグ絞り込みは画面下部中央の `FloatingTagFilter`（`position: fixed`）。アイコンのみの円形トリガー + IDE のファイルツリー風パネル（`TagFilterTree`、フォルダ/タグの stroke アイコン + チェブロン展開）。一覧側はフローティングバーとの重なりを避ける bottom padding を確保する。
- 記事ページ = 左コンテンツ + `--layout-sidebar-w` 固定の右 TOC サイドバーを `flex justify-between` で並べる。`lg` 以下でサイドバーは折りたたまれる。
- TOC の sticky オフセットは `top: calc(var(--layout-header-h) + var(--layout-nav-h) + var(--space-5))` で計算する。マジックナンバー禁止。
- フッターは `position: absolute; bottom: 0;` で body 下部に `--layout-footer-h` 分の余白を予約。ヘッダーは sticky **にしない**。
- **`display: grid` を使わない.** マルチカラムは Flex + `gap`。

### 透過 / blur

- **使わない.** `backdrop-filter` なし、glassmorphism なし、半透明オーバーレイなし。TOC の `is-active` トラックで opacity を載せた muted 色を使うのが唯一の例外。

### イメージの雰囲気

- 記事サムネは user 提供の OGP 画像をコンテンツとして扱う。コンテナ：`150×100`（コンテンツ寸法）、`object-cover`、`--radius-md`、`loading="lazy"`。フィルタ・ティント・オーバーレイなし。

### このシステムが拒絶するもの

- レインボー / 青紫グラデーション
- ネオン影
- 絵文字まみれの UI
- 角丸 + 着色レフトボーダーアクセントのカード
- Tailwind プリセットパレット（`bg-blue-500`, `text-red-500`）— CSS 変数を使う方針なので禁止
- インラインの `style={{ color: '#…' }}` ハードコード — 禁止

---

## アイコン

**方針.** `public/assets/` に小規模な手作りの単色 SVG セットがある。アイコンフォントもアイコンライブラリも使わない（Lucide も Heroicons も使わない）。新しいアイコンが必要なときは既存のスタイルに合わせる：単一 fill or stroke、グラデーション禁止、多色グリフ禁止。

### マスコット — `ochaIcon`

笑顔の抹茶カップ。これがブランドマーク。favicon、Timeline レコードの bullet、マーケティングコンセプトのロゴ、ソーシャルリンクの「homepage」アイコンとして登場する。**常にフルカラー**（抹茶ボディ `#6e9050`、フォーム `#bde030`、頬 `#fff9f9`）。反転したり再着色したりしない。

### ソーシャルリンクのグリフ

単色ブランドマーク（コンテナの `color: inherit` で `--color-text` を継承し、light/dark を自動切替）。すべて `24×24` ボックスサイズ。

| ファイル                     | サービス                                     |
| ---------------------------- | -------------------------------------------- |
| `public/assets/github.svg`   | GitHub (`shuntaka9576`)                      |
| `public/assets/x.svg`        | X / Twitter (`shuntaka_dev`)                 |
| `public/assets/zenn.svg`     | Zenn (`shuntaka`)                            |
| `public/assets/sd.svg`       | SpeakerDeck                                  |
| `public/assets/devio.svg`    | DevelopersIO（Classmethod 著者プロフィール） |
| `public/assets/bluesky.svg`  | Bluesky                                      |
| `public/assets/ochaIcon.svg` | 個人サイト本体                               |

### 機能アイコン

ファイルとしてではなく、SVG パスをインライン埋め込みする：

- **トグルの月 / 太陽**（`ToggleSwitch.tsx`）— moon `circle` + sun `path` SVG をスライド式 pill ノブと組み合わせ。
- **コピーボタン**（`globals.css` + `ArticleContent.tsx` の DOM 注入）— クリップボードグリフ。
- **GitHub-embed のコピー / チェック** — コピーボタンと同系列。

### `404.svg`

404 ページで使う、独自にイラスト化された 404 マーク（Figma マーケティングフレームでも一度使われている）。

### 代替

なし — 本番アイコンセットは小さく、すべてそのまま使える。`public/assets/` に無いグリフが必要な場合は **Lucide**（stroke スタイル：1.5px、塗りなし）を優先し、PR description で代替したことを明記する。

---

## 留意点

- **フォント.** 本番は `apps/web/src/app/layout.tsx` の `<head>` に self-host の `<link rel="stylesheet">` を 2 本（`/fonts/gen-interface-jp/{400,600}.css`）読み込ませている。woff2 は CSS 内の URL 経由で jsDelivr CDN から取得（`preconnect` 維持）。書体名は `Gen Interface JP` で、`globals.css` の `body { font-family: 'Gen Interface JP', … }` から参照する。和文グリフの中身は Noto Sans JP（合成元）なので、CDN 障害時もシステムフォントスタックへフォールバックすれば見た目の劣化は最小限。
- **Hiragino Sans (Figma) → Gen Interface JP（本番）.** Figma が macOS デフォルトの Hiragino Sans で表示するのは下書き確認用。本番は環境を問わず動く Gen Interface JP（和文は Noto Sans JP 合成）に統一する。
- **Dark mode.** トークンは `<html>` の `[data-theme='dark']` で切り替わり、`ToggleSwitch` がそれを操作する。明示的な theme が保存されていないとき `prefers-color-scheme: dark` も尊重する。

---

## 実装ポインタ

- **責務分離.** 値の唯一の真実は `globals.css`（トークン定義）。視覚的に値を確認したいときは Storybook の `Design System/Tokens` を開く。この `DESIGN.md` は voice / 原則 / 禁止事項を担い、具体値は **トークン名で参照する**（hex / px / ms / rem を直接書かない）。マスコット `ochaIcon` の 3 色だけは「再着色しない」設計上の例外として hex のまま残す。
- **トークン実装.** すべてのデザイントークン（color、spacing、radius、line-height、type scale、motion、shadow）は `src/app/globals.css` にある。Light の値は `:root` に、Dark の上書きは `[data-theme='dark']` と `prefers-color-scheme: dark` ブロックに置く。
- **視覚カタログ.** `apps/web/.storybook/` に Storybook（Storybook 10 + `@storybook/nextjs-vite`）を置く。Story は本番コンポーネントとトークンのスウォッチをカバーする。
  - ローカル起動: `bun run storybook`（main 既定 `http://localhost:43005`。worktree では `STORYBOOK_PORT`）
  - 静的ビルド: `bun run build-storybook` → `apps/web/storybook-static/`
  - デプロイ: `main` への push で `.github/workflows/docs.yaml` がトリガーされ、Sphinx docs と同じ artifact に同梱されて GitHub Pages に公開される（`STORYBOOK_BASE_PATH=/shuntaka-dev/storybook/`）。
- **コンポーネント.** `src/components/*.tsx` が UI の正本。新しい視覚要素を作るときは生 HTML を書くより、既存コンポーネントを拡張するか新しい Story を追加することを優先する。
