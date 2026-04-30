# shuntaka.dev デザインシステム

**shuntaka.dev**（髙橋俊一 / shuntaka による、読み物中心の静かな日本語テックブログ）のデザインシステム。ブランドは 1 つのマスコット **抹茶カップ (ochaIcon)**、1 色のアクセント **マゼンタピンク (`--color-accent`)**、そして GitHub-Dark 風のダークモードで構成される。

## 仕様の出どころ

- **Source of truth** — このファイル（ルール + voice）と `src/app/globals.css`（トークン実装）。
- **視覚カタログ** — `apps/web/.storybook/`（`bun run storybook` で起動）。`main` マージで GitHub Pages に自動デプロイ。
- **Figma**（`shuntaka.dev.fig`）— ロゴ検討、シェアボタン OGP、MacBook Pro 一覧ビュー、検索 / タグビュー、Timeline 読書履歴ウィジェットなどの初期コンセプト。Figma は _コンセプト精度_ であり、衝突した場合はコードベースが正。

## ブランドコンテキスト

shuntaka.dev は、日本人ソフトウェアエンジニアの個人テックブログ。**tech**、**note**、**who?** の 3 セクション構成で、記事は Markdown で書かれサーバーサイド（Rust + comrak + syntect）で HTML に変換される。読書体験で重視するのは：

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

- **英語:** Roboto (400/700) — `next/font/google` で読み込み、`--font-roboto` で公開。
- **日本語:** Noto Sans JP — `--font-noto-sans-jp` で公開。（Figma 下書きは Hiragino Sans を使うが、本番は macOS 限定を避けて Noto Sans JP）
- **Mono:** システムスタック（`ui-monospace, SFMono-Regular, …`）。
- **スケール.** 9 段階の `--fs-display` / `--fs-h1` / `--fs-h2` / `--fs-h3` / `--fs-h4` / `--fs-body-lg` / `--fs-body` / `--fs-caption` / `--fs-code`。実値は `globals.css` と Storybook `Design System/Tokens` を参照。
- **行高.** 本文 `--lh-body`（読書体験のため大きめ）。見出し `--lh-heading`。リスト `--lh-list`。
- **`em` と `px` を混ぜない.** タイポは `rem`、レイアウトは `px` またはレイアウトトークン。
- **強調は `<strong>` のみ.** 着色強調・全大文字・letter-spacing いじりはしない。

### ラベル / 表記

- **大文字小文字.** タブラベルとサイトタイトルは小文字（`tech`, `note`, `who?`, `shuntaka.dev`）。記事内見出しを Title Case にしない。
- **日付.** 常に `YYYY/MM/DD`（例: `2021/03/12`）。記事タイムスタンプは `MM/DD HH:mm YYYY`。
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

- 本番 CSS で実際に使う影は **1 つだけ**：`link-card:hover` の `--shadow-2`。
- 4 段階の elevation トークン（`--shadow-0`…`--shadow-3`）は将来のモーダル / ポップオーバー用に予約済みだが、現状未使用。
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

### レイアウトルール

- 外側は `--layout-max` の単一カラム中央寄せ。記事一覧は `--layout-list-max` で内側を絞る。
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

- **フォント.** 本番は `next/font` で Roboto + Noto Sans JP を読み込み、`--font-roboto` / `--font-noto-sans-jp` として公開する。CDN 依存はなく、`next/font` がビルド時にサブセットをセルフホスト。
- **Hiragino Sans (Figma) → Noto Sans JP（本番）.** Figma が macOS デフォルトの Hiragino Sans を表示しているのは見た目確認用。本番は環境を問わず動く Noto Sans JP を使う。視覚的にはほぼ等価とみなす。
- **Dark mode.** トークンは `<html>` の `[data-theme='dark']` で切り替わり、`ToggleSwitch` がそれを操作する。明示的な theme が保存されていないとき `prefers-color-scheme: dark` も尊重する。

---

## 実装ポインタ

- **責務分離.** 値の唯一の真実は `globals.css`（トークン定義）。視覚的に値を確認したいときは Storybook の `Design System/Tokens` を開く。この `DESIGN.md` は voice / 原則 / 禁止事項を担い、具体値は **トークン名で参照する**（hex / px / ms / rem を直接書かない）。マスコット `ochaIcon` の 3 色だけは「再着色しない」設計上の例外として hex のまま残す。
- **トークン実装.** すべてのデザイントークン（color、spacing、radius、line-height、type scale、motion、shadow）は `src/app/globals.css` にある。Light の値は `:root` に、Dark の上書きは `[data-theme='dark']` と `prefers-color-scheme: dark` ブロックに置く。
- **視覚カタログ.** `apps/web/.storybook/` に Storybook（Storybook 10 + `@storybook/nextjs-vite`）を置く。Story は本番コンポーネントとトークンのスウォッチをカバーする。
  - ローカル起動: `bun run storybook`（`http://localhost:6006`）
  - 静的ビルド: `bun run build-storybook` → `apps/web/storybook-static/`
  - デプロイ: `main` への push で `.github/workflows/docs.yaml` がトリガーされ、Sphinx docs と同じ artifact に同梱されて GitHub Pages に公開される（`STORYBOOK_BASE_PATH=/shuntaka-dev/storybook/`）。
- **コンポーネント.** `src/components/*.tsx` が UI の正本。新しい視覚要素を作るときは生 HTML を書くより、既存コンポーネントを拡張するか新しい Story を追加することを優先する。
