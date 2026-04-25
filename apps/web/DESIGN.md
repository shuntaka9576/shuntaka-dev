# DESIGN.md

`apps/web`（Next.js 16 + React 19 + Tailwind CSS 4 のブログフロントエンド）のデザインシステム定義。
[VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) / [Stitch DESIGN.md format](https://stitch.withgoogle.com/docs/design-md/format/) に準拠した 9 セクション構成。

## 0. このドキュメントについて

- **想定読者**: このリポジトリで UI を変更する人間、および Claude Code / Google Stitch 等の AI コーディングエージェント。
- **本編は To-be（推奨される姿）を記述する**。実装がまだ追従していない箇所は「付録 A: 現状の不整合カタログ」で個別に提示する。
- **更新ルール**: 色・スペーシング・タイポグラフィ・コンポーネントを追加／変更したら、このファイルを必ず更新する。デザイントークンの名前はここを正とする。
- **関連ファイルインデックス**
  - `apps/web/src/app/globals.css` — CSS 変数、`.prose`、レイアウト用クラス。
  - `apps/web/src/app/layout.tsx` — フォント読み込み、プロバイダー配置。
  - `apps/web/src/components/BaseLayout.tsx` — ヘッダー / ナビ / フッターの枠。
  - `apps/web/src/components/ThemeProvider.tsx` — ライト／ダーク切り替え。
  - `apps/web/src/components/ToggleSwitch.tsx` — ダークモードトグル UI。
  - `apps/web/src/components/ArticleCard.tsx` — 記事カード。
  - `apps/web/src/components/ArticleContent.tsx` — 記事本文（Markdown→HTML 済み）のレンダリング。
  - `apps/web/src/components/TableOfContents.tsx` — 目次（tocbot）。

## 1. Visual Theme

- **ムード**: 静かで可読性を優先したテックブログ。装飾は最小限、コードブロック・画像・リンクカードといった「引用物」が主役。
- **情報密度**: 中（行高 1.9 / 広めの余白）。
- **カラーフィーリング**: ライトは温白を基調とした淡クール、ダークは GitHub Dark ライクなネイビー系。差し色として **マゼンタピンク `#e4007f`（ブランドアクセント）** を 1 色のみ使う。
- **許容しない方向性**: 派手な虹色グラデーション、ネオンシャドウ、過剰なアニメーション、カラフルなアイコンセット。
- **シェイプ**: 角丸は **4px / 6px / 10px / 15px** の 4 段階（それぞれボタン／カード小／カード大／記事エリア）。直線的なエッジは使わない。

## 2. Color Palette & Roles

> 実装は Tailwind v4 の `@theme` ブロック（`apps/web/src/app/globals.css`）で CSS カスタムプロパティとして公開する前提。現状は `--tag-*` / `--message-*` などが混在しているので、**セマンティック名への整理が To-be**。

### 2.1 セマンティックトークン（To-be）

| 役割                                            | 用途                                                       | ライト値                | ダーク値                | 現行トークン（統合元）                                |
| ----------------------------------------------- | ---------------------------------------------------------- | ----------------------- | ----------------------- | ----------------------------------------------------- |
| `--color-bg`                                    | ページ地色                                                 | `#f7fafc`               | `#22272e`               | `--bg-color`                                          |
| `--color-surface`                               | カード／記事エリア／TOC 背景                               | `#ffffff`               | `#22272e`               | `--article-area-color`                                |
| `--color-surface-raised`                        | ヘッダー／ナビ背景                                         | `#fffefc`               | `#2d333b`               | `--header-color`                                      |
| `--color-text`                                  | 本文                                                       | `#525457`               | `#c9d5e1`               | `--text-color`                                        |
| `--color-text-muted`                            | 日付・キャプション・TOC 非アクティブ                       | `#57595b` @54%          | `#ffffff` @47%          | `--toc-list-text-color`                               |
| `--color-border`                                | 汎用ボーダー                                               | `#c4c4c4`               | `#30363d`               | `--tag-h1-border-line-color`, `--github-embed-border` |
| `--color-border-subtle`                         | 記事カード下線                                             | `rgba(162,177,202,0.3)` | `rgba(247,250,252,0.3)` | `--article-record-underline`                          |
| `--color-accent`                                | ブランドアクセント／ダーク時のトグル ON 色／NProgress バー | `#e4007f`               | `#e4007f`               | `--message-error-border-color`, トグル内 `#e40067`    |
| `--color-link`                                  | リンク基調                                                 | `#5c6eb1`               | `#539bf5`               | `--tag-a-color`                                       |
| `--color-link-hover`                            | リンクホバー                                               | `#6686ff`               | `#79b8ff`               | `--tag-a-hover-color`                                 |
| `--color-link-visited`                          | リンク既読（ダークでも視認できる色に変更）                 | `#6200ac`               | `#b392f0`               | `--tag-a-visited-color`                               |
| `--color-code-inline-bg`                        | インラインコード背景                                       | `rgb(27 31 35 / 5%)`    | `rgb(69 75 83)`         | `--tag-code-background-color`                         |
| `--color-code-inline-fg`                        | インラインコード文字                                       | `#333`                  | `#c9d5e1`               | `--tag-code-color`                                    |
| `--color-code-block-bg`                         | `<pre>` 背景                                               | `#1e1e1e`               | `#1e1e1e`               | （現状ハードコード、統合必要）                        |
| `--color-code-block-fg`                         | `<pre>` 文字                                               | `#d4d4d4`               | `#d4d4d4`               | （現状ハードコード）                                  |
| `--color-info-bg` / `--color-info-border`       | 情報メッセージ                                             | `#e7f1ff` / `#3b82f6`   | `#1f2a37` / `#3b82f6`   | （新規）                                              |
| `--color-success-bg` / `--color-success-border` | 成功メッセージ                                             | `#e7f7ed` / `#16a34a`   | `#1c2b24` / `#16a34a`   | （新規）                                              |
| `--color-warning-bg` / `--color-warning-border` | 警告メッセージ                                             | `#fff2b8`               | `#2d333b` / `#fcc800`   | `--message-warn-*`                                    |
| `--color-danger-bg` / `--color-danger-border`   | エラーメッセージ／破壊的操作                               | `#eb6e9f36`             | `#2d333b` / `#e4007f`   | `--message-error-*`                                   |

### 2.2 ダークモード戦略

- `document.documentElement.dataset.theme = 'light' | 'dark'` を **正の制御軸**にする（`ThemeProvider` が管理、`localStorage.color-mode` に永続化）。
- ユーザー未選択時は `@media (prefers-color-scheme: dark)` を `:root:not([data-theme='light'])` でフォールバック適用。
- フォント色・背景色・ボーダーの **3 カテゴリは必ず CSS 変数経由**。Tailwind のプリセット色 (`bg-blue-500` 等) は使用禁止（§7 Don't 参照）。
- インラインの `style={{ color: '#xxx' }}` は禁止。CSS 変数を参照するか、Tailwind arbitrary property (`bg-[var(--color-surface)]`) を使う。

### 2.3 コントラスト

- `--color-text` on `--color-bg` は WCAG AA（4.5:1）を満たすこと。新色を追加する前に最低限チェック。
- `--color-accent` はアイコンおよび 1px ボーダーでのみ使用。**文字色に使うなら太字＆14px 以上**。

## 3. Typography

### 3.1 フォントスタック

- **英字**: `Roboto`（`next/font/google`、weight 400 / 700、`--font-roboto`）。
- **和文**: `Noto Sans JP`（`next/font/google`、`--font-noto-sans-jp`）。
  - 現状 `subsets: ['latin']` のみで日本語サブセットを引けていない。**To-be**: `display: 'swap'` と `preload: true` を維持しつつ、日本語フォントは `next/font` の自動サブセット化に委ねる（`subsets` 指定を外すか、必要なら `weight` を限定する）。
- **フォールバック**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif`。
- **等幅**: `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`。

### 3.2 タイポグラフィスケール（To-be、単位は `rem` 基準）

基準 `1rem = 16px`、本文行高 `1.9`、見出し行高 `1.4`。

| 役割      | font-size        | line-height | weight | 用途                         |
| --------- | ---------------- | ----------- | ------ | ---------------------------- |
| `display` | 2rem (32px)      | 1.3         | 700    | 記事タイトル（デスクトップ） |
| `h1`      | 1.7rem           | 1.4         | 700    | 本文 h1                      |
| `h2`      | 1.5rem           | 1.4         | 700    | 本文 h2                      |
| `h3`      | 1.25rem          | 1.4         | 700    | 本文 h3                      |
| `h4`      | 1.125rem         | 1.5         | 700    | 本文 h4                      |
| `body-lg` | 1rem             | 1.9         | 400    | 記事段落                     |
| `body`    | 0.9375rem (15px) | 1.7         | 400    | 一覧／カード本文             |
| `caption` | 0.8125rem (13px) | 1.6         | 400    | 日付、著作メタ               |
| `code`    | 0.875rem         | 1.6         | 400    | `<pre>` 内コード             |

- **禁則**
  - `em` / `px` の混在禁止。上表の `rem` に統一。
  - `font-weight: 530` などの非標準値は作らない。中間が欲しい場合は `500` を使う（Roboto 500 を読み込むか、fallback の Noto Sans JP の 500 を利用）。
- **Prose** (`.prose` / `.prose-lg`)
  - 現状 `@tailwindcss/typography` プラグインは **未導入**。`.prose` は `globals.css` で自前定義されている。`prose-lg` クラスは何の効果もない（プラグイン由来のため）ので、**新規コードでは `prose-lg` を付けない**。本編スタイルは `.prose` のみで成立する。

### 3.3 リンク・装飾

- 本文リンクは `.prose a` のみ色とカラー変化を適用。`underline` はつけず **hover で色だけ変える**。
- 記事外リンク（ナビ、カード）はデフォルトの inherit 色で、アクティブ状態は下線 (`border-b-2`) で示す（`BaseLayout` と一貫させる）。
- 強調は `<strong>` を `font-weight: 700` のみ。色やサイズでの強調は禁止。

## 4. Component Styling

### 4.1 レイアウト骨格

- **ヘッダー** (`BaseLayout`、`apps/web/src/components/BaseLayout.tsx`)
  - 高さ `3rem` (`h-12`)、背景 `--color-surface-raised`、sticky ではない（現状通り）。
  - 左: サイトタイトル `shuntaka.dev`（`text-2xl font-bold`）。右: `ToggleSwitch`。
  - パディング: 水平 `px-8`、モバイル `px-[2%]` → **To-be** では `px-4` (16px) に正規化。
- **タイプナビ** (`tech / note / who?`)
  - アクティブタブ: `border-b-2`、ボーダー色は `--color-text`。
  - インアクティブ: 装飾なし、hover で下線だけ薄く（現状未実装 → To-be で追加推奨）。
- **ページコンテナ**
  - `max-w-[1200px]` → **トークン `--layout-max: 1200px`** として公開。
  - 記事一覧の内側: `max-w-[600px]` → `--layout-list-max: 600px`。
  - メイン領域の下パディング `pb-[58px]` はフッター高さ。**フッターを高さトークン `--layout-footer-h: 58px` にして、コンテナは `pb-[var(--layout-footer-h)]` で参照**。
- **フッター** (`Footer.tsx`)
  - 固定配置 (`absolute bottom-0`)、フォントサイズ `caption`。
- **記事本文ラッパ** (`.article-content-wrapper`)
  - 背景 `--color-surface`、角丸 `15px`、ボーダー 1px `--color-border-subtle`、パディング `3rem 1rem`（デスクトップ）／ `1.5rem 1rem`（sm 以下）。
  - sm 以下で外側 `BaseLayout` の `px-4` (16px) と合わせて左右合計 32px の余白を確保し、本文・コード・画像が画面端に張り付かないようにする。
- **右サイドバー / TOC** (`.right-sidebar`, `.toc`)
  - 幅 `296px`（`--layout-sidebar-w: 296px`）。
  - `position: sticky; top: 112px;` はヘッダー + タイプナビ分の高さ。ヘッダー高さが変わったら一緒に変える。**マジックナンバーを避けるため `calc(var(--layout-header-h) + var(--layout-nav-h) + 16px)` で算出するのが理想**。
  - `lg` 未満で非表示。

### 4.2 基本コンポーネント

#### Button（実装: `apps/web/src/components/Button.tsx`）

- Variant: `primary`（accent）/ `secondary`（surface-raised + border）/ `ghost`（transparent）/ `danger`（danger-border）。
- Size: `sm`（h-8 px-3 text-sm）/ `md`（h-10 px-4 text-base）/ `lg`（h-12 px-5 text-base）。
- 状態
  - `default`: variant ごとの背景。文字は variant に応じて `white` または `--color-text`。
  - `hover`: `brightness-95` で 5% 暗化。
  - `focus-visible`: グローバルの `:focus-visible` 共通ルールで `outline: 2px solid var(--color-accent)`。
  - `active`: `brightness-90`。
  - `disabled` / `loading`: `disabled:opacity-50 disabled:cursor-not-allowed`、`aria-busy` 設定。
  - `loading`: 左にインラインスピナー、ボタン自体は `disabled`。
- 使用例: `<Button variant="primary" onClick={...}>再試行</Button>`。`apps/web/src/app/error.tsx` と `apps/web/src/app/[userName]/articles/[slug]/error.tsx` で使用中。

#### Link / ProgressLink

- `ProgressLink` は Next.js `<Link>` ラッパ。内部遷移に必ず使う。
- focus-visible リング: `outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: 4px;` を全 `a` に共通で当てる（globals.css に 1 か所）。

#### ArticleCard

- 構造: `<ProgressLink><article><div (title + date)><Image thumbnail></div></article></ProgressLink>`。
- 下線: `border-b` + `--color-border-subtle`（現状維持）。
- サムネイル: `150×100`、`rounded-[10px]`、`loading="lazy"`、`object-cover`。**To-be** はトークン `--radius-md: 10px` を使って `rounded-md` クラス化。
- タイトル: `body-lg`、日付: `caption`、`--color-text-muted`。

#### ToggleSwitch（ダークモード）

- トラック `42×16` / ノブ `24×24`。
- ダーク時の背景は **`--color-accent`**（現状インラインの `#e40067` を統合）。
- SVG 内の `circle` 色（`#525457`）と `path` 色（`#FFF33F`）は専用トークン `--color-toggle-moon: #525457` / `--color-toggle-sun: #fff33f` として定義。
- 状態
  - `focus-visible`: 標準 focus ring を付与（現状なし）。
  - アクセシブルネーム: `aria-label="ライトモードに切り替え" | "ダークモードに切り替え"`（現状通り）。
  - タッチターゲット: トラック実寸が `42×16` で **44×44 基準を満たしていない**。`button` の min-width / min-height を `44px` に拡張するか、`padding` で hit area を広げる。

#### Callout / Message (`.message`, `.message.error`)

- Variant: `info` / `success` / `warning` / `danger`（現状は warning がデフォルト、error のみ明示。**info / success は新規定義**）。
- 共通: `padding: 16px; border-radius: 6px; border: 1px solid <variant-border>; background: <variant-bg>;`。
- 行内リンクは `text-decoration: underline;`（現状通り）。
- 読み上げ: `role="note"` を付けるか、`danger` の場合 `role="alert"`。

#### Code Block (`.code-block-container`, `.prose pre`, `.copy-btn`)

- 構造: `<div class="code-block-container"><span class="code-block-filename">file.tsx</span><pre><code>...</code></pre><button class="copy-btn" aria-label="Copy code">...</button></div>`。
- 色は `--color-code-block-bg` / `--color-code-block-fg` に統一。ダークでもライトでも同色でよい（可読性優先）。
- copy ボタン
  - `position: absolute; top: 8px; right: 8px;`、透明度 0.4 → hover で 1.0（現状通り）。
  - `aria-label="Copy code"` を必ず付ける。
  - **命名統一**: `.github-embed-copy`, `.code-block-copy`, `.copy-btn` の 3 クラスが混在中 → `.copy-btn` に寄せる方針。イベントハンドラ側（`ArticleContent.tsx:91`）も同時に整理。
- copy フィードバック: 0.8 秒間 `Copied!` を表示してフェード（`@keyframes float-up`）。

#### Link Card (`.link-card`)

- 外枠 1px `--color-border`、角丸 `8px`。hover で border-color を `--color-link` に、`--shadow-2` を付与。
- デスクトップ画像 `180×100`、モバイル `100×67`（16:9 ベース）。

#### JsonLd / Analytics 系

- ユーザーに表示されないためデザイン要件なし。ただし `<Script>` 挿入位置は body 内に限定する（既存通り）。

### 4.3 状態スタイル ルール（全コンポーネント共通）

| 状態            | 規約                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `hover`         | 色・透明度・シャドウのどれかを 1 段階だけ変える。複数同時変更は避ける。                                        |
| `focus-visible` | **必ず** `outline: 2px solid var(--color-accent); outline-offset: 2px;` を付与。現状ほぼ未実装なので優先度高。 |
| `active`        | クリック実感のため 1px 沈みもしくは輝度 -6%。                                                                  |
| `disabled`      | `opacity: 0.5; pointer-events: none;`、`aria-disabled="true"`。                                                |
| `loading`       | インタラクション抑止、`aria-busy="true"`。視覚はスピナーまたは `animate-pulse`。                               |

## 5. Layout Principles

### 5.1 スペーシングスケール（4px 基点）

| トークン     | 値   | 主な用途                       |
| ------------ | ---- | ------------------------------ |
| `--space-0`  | 0    | リセット                       |
| `--space-1`  | 4px  | アイコン余白                   |
| `--space-2`  | 8px  | リスト項目内                   |
| `--space-3`  | 12px | カード内要素間                 |
| `--space-4`  | 16px | カードパディング、本文マージン |
| `--space-5`  | 24px | セクション間                   |
| `--space-6`  | 32px | 主要ブロック間                 |
| `--space-8`  | 48px | ページトップ余白               |
| `--space-10` | 72px | フッター前の余白               |

- **現状のマジックナンバーとの対応**
  - `margin-bottom: 13px`（リスト項目）→ `--space-3` (12px) に寄せる。
  - `margin-top: 10px`（ul / ol）→ `--space-2` (8px) or `--space-3` (12px)。
  - `pb-[58px]`（コンテナ下）→ フッター高さトークン `--layout-footer-h: 58px`。
  - `padding: 3.2em 16px`（`.article-content-wrapper`）→ `3rem 1rem`（`--space-6 × --space-4`）で揃え済み。sm 以下は `1.5rem 1rem`（`--space-5 × --space-4`）。

### 5.2 コンテナ幅トークン

- `--layout-max`: 1200px（ページ外枠）。
- `--layout-list-max`: 600px（記事一覧の 1 カラム幅）。
- `--layout-sidebar-w`: 296px（右サイドバー）。
- `--layout-header-h`: 48px。
- `--layout-nav-h`: 40px。
- `--layout-footer-h`: 58px。

### 5.3 グリッド / 配置

- 基本は **1 カラム + 右サイドバー**（`flex justify-between`）。
- `lg` 未満でサイドバーを `display: none` にして 1 カラムへ畳む。
- Grid は現状未使用。リンクカードなどで 2 カラムが必要になっても CSS Grid ではなく Flex + `gap` で対応（シンプルさ優先）。

### 5.4 余白哲学

- **縦リズムを最優先**。見出し前後に `--space-5` 〜 `--space-6`、段落間は `1em`（行高と同調）。
- **角丸は 4 段階**: `--radius-sm: 4px`（ボタン・タグ）、`--radius-md: 10px`（カード）、`--radius-lg: 15px`（記事エリア）、`--radius-full: 9999px`（トグルスイッチ・円形アイコン）。

## 6. Depth & Elevation

現状 box-shadow は `.link-card:hover` の 1 箇所のみ。将来のモーダル／ポップオーバー追加に備えて以下を予約する。

| トークン     | 値                            | 用途                             |
| ------------ | ----------------------------- | -------------------------------- |
| `--shadow-0` | `none`                        | フラットなデフォルト             |
| `--shadow-1` | `0 1px 2px rgba(0,0,0,0.06)`  | カード静止状態（任意）           |
| `--shadow-2` | `0 2px 8px rgba(0,0,0,0.10)`  | カード hover、sticky ヘッダー    |
| `--shadow-3` | `0 8px 24px rgba(0,0,0,0.14)` | モーダル、ポップオーバー（将来） |

- サーフェス階層: `body (bg) < surface (記事エリア、TOC) < surface-raised (ヘッダー、ナビ) < overlay (未実装)`。
- ダーク時のシャドウは目立ちにくいので、代わりに `border-color` を 1 段明るくする表現も可。

## 7. Do / Don't

### ✅ Do

- 色はすべて **CSS 変数**（またはそれを参照する Tailwind arbitrary `bg-[var(--color-accent)]`）経由で指定する。
- 条件付き className は `cn()` ユーティリティ（`clsx` + `tailwind-merge`）を介して組み立てる。三項演算子の生文字列連結は避ける。
- すべての `button` / `a` / `[role="button"]` に `focus-visible` のアウトラインを付ける（§4.3 共通ルール）。
- `next/image` には必ず `alt` / `sizes` を付け、固定 `width`・`height` または `aspect-ratio` で CLS を防ぐ。
- Markdown 由来の HTML を表示するときは **API 側でサニタイズ済み**であることを確認し、信頼できないソースは `<iframe sandbox>` に入れる。
- 新しい色・サイズ・コンポーネントを追加したら、**まず本 DESIGN.md を更新**してから実装する。

### ❌ Don't

- Tailwind のプリセット色 (`bg-blue-500`, `text-red-500`, `text-gray-600` 等) を直接クラスに書かない。**セマンティックトークン経由**にする。
- `style={{ backgroundColor: '#xxx' }}` のようなハードコードをコンポーネント内に書かない。`ToggleSwitch` の `#e40067` / `#FFF33F`、`BaseLayout` の `style={{ background: 'var(--header-color)' }}` のようなパターンは **class ベースに移し替える**。
- Tailwind arbitrary value (`px-[2%]`, `pb-[58px]`, `max-w-[1200px]`) を新規に書かない。既存も順次トークン化する。
- `em` と `px` を混在させない。タイポは `rem`、レイアウトは `px`（または `--space-*` / `--layout-*` トークン）で統一。
- `dangerouslySetInnerHTML` に外部ソースの HTML を直接渡さない（信頼できる API レスポンスに限定）。
- `prose-lg` クラスを新規に付けない（プラグイン未導入のため無効）。

## 8. Responsive Behavior

### 8.1 ブレークポイント

Tailwind の min-width ベースに揃える。

| 名前     | min-width | 想定デバイス                |
| -------- | --------- | --------------------------- |
| （base） | 0         | モバイル縦                  |
| `sm`     | 640px     | モバイル横 / 小型タブレット |
| `md`     | 768px     | タブレット縦                |
| `lg`     | 1024px    | タブレット横 / 小型 PC      |
| `xl`     | 1280px    | デスクトップ                |

- **注意**: `globals.css` では `max-width: 576 / 768 / 1024` の max-width 記述が残っている。新規スタイルは min-width ベース（Tailwind の `sm:` / `md:` / `lg:` クラス）で書き、既存の max-width ルールは §付録 A の表に従って順次置換する。

### 8.2 折りたたみ戦略

- 記事本文タイトル: `md` 未満で中央寄せ → 左寄せ、サイズを `1.4rem` に縮小。
- TOC（右サイドバー）: `lg` 未満で非表示。
- コードブロック: 常に `overflow-x: auto`、**折り返さない**。スクロールバーを許容する。
- リンクカード画像: `md` 未満で高さを縮めて縦積みに近い配置へ。
- SpeakerDeck 埋め込み: `md` 未満で `width: 100%` に拡張。

### 8.3 タッチターゲット

- インタラクティブ要素の実効ヒット領域は **最小 44×44px**。
- 現状、`.toggle-switch` の実寸は `42×16`。`button` の `min-width: 44px; min-height: 44px;` を追加して padding で見かけを保つ対応が必要。
- コピー ボタン (`.copy-btn`) も透明度 0.4 状態でタップできるよう 36px 以上のヒット領域を確保。

## 9. Agent Prompt Guide

### 9.1 クイックカラーリファレンス

- 背景: `var(--color-bg)` / サーフェス: `var(--color-surface)` / 強調面: `var(--color-surface-raised)`
- 文字: `var(--color-text)` / ミュート: `var(--color-text-muted)`
- アクセント: `var(--color-accent)` （hover / focus / アクティブ指示）
- リンク: `var(--color-link)` / `var(--color-link-hover)` / `var(--color-link-visited)`
- フィードバック: `--color-info-*` / `--color-success-*` / `--color-warning-*` / `--color-danger-*`

### 9.2 すぐ使えるプロンプト例

- 新規コンポーネントを追加するとき
  > `apps/web/DESIGN.md` の §2（カラー）、§5.1（スペーシング）、§4.3（状態）のトークンのみを使用してください。Tailwind のプリセット色 (`red-500` 等) と任意値 (`px-[13px]` 等) は使わず、CSS 変数 `var(--color-*)` または `--space-*` を参照してください。
- ボタンを追加するとき
  > `Button` コンポーネント（variant: `primary` / `secondary` / `ghost` / `danger`、size: `sm` / `md` / `lg`）を使ってください。未実装の場合は `apps/web/DESIGN.md` §4.2 の仕様で新規作成し、使用箇所を置き換えてください。
- スタイル修正のとき
  > 現状 `style={{}}` インラインで書かれている色・サイズは、`apps/web/DESIGN.md` §7 Don't に該当します。CSS 変数参照の className ベースに移し替えてください。

### 9.3 このドキュメントを更新する条件

1. 新しい **色** を導入した（または既存色を変更した）。
2. 新しい **コンポーネント** を `components/` に追加した。
3. 新しい **スペーシング値** / **ブレークポイント** / **タイプスケール** を使った。
4. `globals.css` の CSS 変数の追加・削除・改名を行った。
5. **Don't** に該当する実装を意図的に残した（理由と期限を付録 A に追記）。

上記いずれかに該当したら、PR 本文に「DESIGN.md 更新済み」を明記する。

---

## 付録 A: 現状の不整合カタログ（As-is の逸脱リスト）

`file_path:line` 付き。**本編の To-be に揃える**ためのリファクタ候補。
ステータス: ✅ 対応済み / ⏳ 残課題（リスク or 後続タスク）。

### A-1. 色・テーマ

| ステータス | 箇所                                                                                                                                  | 内容                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅         | `apps/web/src/app/error.tsx`                                                                                                          | `bg-blue-500 hover:bg-blue-600 text-white` を `<Button variant="primary">` に置換。                                                                 |
| ✅         | `apps/web/src/app/[userName]/articles/[slug]/error.tsx`                                                                               | 同上。`Button` を使用。                                                                                                                             |
| ✅         | `apps/web/src/app/page.tsx` / `apps/web/src/app/type/note/page.tsx`                                                                   | `text-red-500` → `text-[var(--color-danger-border)]`。                                                                                              |
| ✅         | `apps/web/src/app/not-found.tsx`                                                                                                      | `text-gray-600` → `text-[var(--color-text-muted)]`。                                                                                                |
| ✅         | `apps/web/src/app/globals.css` `.prose pre`                                                                                           | `#1e1e1e` / `#d4d4d4` → `var(--color-code-block-bg)` / `var(--color-code-block-fg)`。                                                               |
| ✅         | `apps/web/src/app/globals.css` `#nprogress .bar` / `.peg`                                                                             | 既存シアン (`#29d`) を `--color-progress` トークン経由に統一（色は元のまま）。                                                                      |
| ⏳         | `apps/web/src/components/ToggleSwitch.tsx`                                                                                            | CSS 変数化を試みたが可動範囲／見た目の違和感が出たため **元の実装に差し戻し**。リデザインとセットで別タスクに切り出し。                             |
| ✅         | `apps/web/src/components/BaseLayout.tsx`                                                                                              | `style={{ background: 'var(...) }}` のインラインを `bg-[var(--color-surface-raised)]` クラスに移行。アクティブタブは `border-[var(--color-text)]`。 |
| ✅         | `apps/web/src/components/ArticleCard.tsx`                                                                                             | `style={{ borderColor: ... }}` を `border-[var(--color-border-subtle)]` に置換。                                                                    |
| ✅         | `apps/web/src/app/loading.tsx` / `apps/web/src/app/type/note/loading.tsx` / `apps/web/src/app/[userName]/articles/[slug]/loading.tsx` | スケルトンの `style={{ background: 'var(--article-area-color)' }}` を `bg-[var(--color-surface)]` クラスに置換。                                    |

### A-2. タイポグラフィ

| ステータス | 箇所                                                     | 内容                                                                                                                           |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| ⏳         | `apps/web/src/app/layout.tsx:19-23`                      | `Noto_Sans_JP({ subsets: ['latin'] })`。挙動への影響が読み切れないため別タスク。`subsets` 指定を外して自動最適化に任せる方針。 |
| ⏳         | `apps/web/src/app/globals.css:149-217`                   | 見出しが `em` ベース。リスクのある変更（全記事の見栄えに影響）のため別タスクで `rem` ベースへ移行。                            |
| ✅         | `apps/web/src/app/globals.css` `.article-title` モバイル | `font-weight: 530` → `700`。                                                                                                   |
| ✅         | `apps/web/src/components/ArticleContent.tsx`             | `prose prose-lg max-w-none` → `prose max-w-none`（`prose-lg` は typography プラグイン未導入で無効だったため除去）。            |

### A-3. スペーシング / レイアウト

| ステータス | 箇所                                                                                                                | 内容                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅         | `apps/web/src/components/BaseLayout.tsx`                                                                            | `max-w-[1200px]` → `max-w-[var(--layout-max)]`、`pb-[58px]` → `pb-[var(--layout-footer-h)]`、`px-[2%]` → `px-4`。`:root` にレイアウトトークンを追加済み。                     |
| ✅         | `apps/web/src/app/page.tsx` / `apps/web/src/app/loading.tsx` / 同 note 配下 / `apps/web/src/app/type/note/page.tsx` | `max-w-[600px]` → `max-w-[var(--layout-list-max)]`。                                                                                                                          |
| ✅         | `apps/web/src/app/globals.css` `.article-content`                                                                   | `calc(100% - 312px)` → `calc(100% - var(--layout-sidebar-w) - var(--space-4))`。                                                                                              |
| ✅         | `apps/web/src/app/globals.css` `.toc`                                                                               | `top: 112px` → `top: calc(var(--layout-header-h) + var(--layout-nav-h) + var(--space-5))`、`max-width: 296px` / `border-radius: 10px` / `padding: 8px` も対応するトークンへ。 |
| ✅         | `apps/web/src/app/globals.css` `.right-sidebar`                                                                     | `width: 296px` → `width: var(--layout-sidebar-w)`。                                                                                                                           |
| ⏳         | `apps/web/src/app/globals.css` リスト / メッセージ / 記事ラッパ                                                     | `margin-top: 10px` / `margin-bottom: 13px` / `font-size: 14.5px` / `padding: 3.2em 16px` は実値が現状値と微差ありの調整となるため、別タスクで段階適用。                       |

### A-4. インタラクション / a11y

| ステータス | 箇所                                                                             | 内容                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ✅         | `apps/web/src/app/globals.css`                                                   | `:is(a, button, [role='button'], input, select, textarea, summary):focus-visible` の共通アウトラインを追加。                     |
| ✅         | `apps/web/src/app/globals.css` `.copy-btn` / `.link-card` / `.github-embed-copy` | `0.2s` を `--motion-base` トークンに置換（`.toggle-label` / `.dark-icon` はトグル差し戻しに伴い元の `0.4s` / `0.2s` に戻した）。 |
| ⏳         | `apps/web/src/components/ToggleSwitch.tsx` + CSS `.toggle-switch`                | 44×44 タッチターゲット化は上記差し戻しにより保留。                                                                               |

### A-5. Markdown / Prose

| ステータス | 箇所                                                | 内容                                                                                                                                                          |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⏳         | `apps/web/src/components/ArticleContent.tsx:59-120` | `useEffect` で `<button.copy-btn>` を DOM 挿入。動作上は許容、API 側に `<button>` 同梱化する案は別タスク。                                                    |
| ⏳         | `apps/web/src/components/ArticleContent.tsx:91-93`  | セレクタ `.github-embed-copy, .code-block-copy, .copy-btn` の 3 重定義。`.copy-btn` 一本化は埋め込み HTML 側との同時改修が必要なため別タスク。                |
| ✅         | `apps/web/src/app/globals.css` `.message`           | `.message.info` / `.message.success` / `.message.warning` を追加、`.message.error` も `--color-danger-*` を参照する形に整理。                                 |
| ✅         | `apps/web/src/app/globals.css`                      | インラインコードは現状互換のため `--tag-code-*` を温存し、エイリアスとして `--color-code-inline-bg` / `--color-code-inline-fg` を追加（移行期間として両立）。 |

## 付録 B: 将来の実装方針メモ

> 本プランのスコープ外。別タスクで段階的に着手する。

### B-1. Tailwind v4 `@theme` ブロックでの公開

```css
@theme {
  --color-bg: #f7fafc;
  --color-surface: #ffffff;
  --color-surface-raised: #fffefc;
  --color-text: #525457;
  --color-text-muted: color-mix(in srgb, #525457 54%, transparent);
  --color-accent: #e4007f;
  --color-link: #5c6eb1;
  --color-link-hover: #6686ff;
  --color-link-visited: #6200ac;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-8: 3rem;
  --space-10: 4.5rem;

  --radius-sm: 0.25rem;
  --radius-md: 0.625rem;
  --radius-lg: 0.9375rem;

  --layout-max: 1200px;
  --layout-list-max: 600px;
  --layout-sidebar-w: 296px;
  --layout-header-h: 48px;
  --layout-nav-h: 40px;
  --layout-footer-h: 58px;

  --motion-fast: 150ms;
  --motion-base: 250ms;
  --motion-slow: 400ms;
}

[data-theme='dark'] {
  --color-bg: #22272e;
  --color-surface: #22272e;
  --color-surface-raised: #2d333b;
  --color-text: #c9d5e1;
  --color-link: #539bf5;
  --color-link-hover: #79b8ff;
  --color-link-visited: #b392f0;
}
```

### B-2. `cn()` ユーティリティ導入

- 依存: `clsx` + `tailwind-merge`。
- 置き場所: `apps/web/src/lib/cn.ts`。
- BaseLayout のアクティブタブ判定など、三項演算子で className を切り替えている箇所を順次置換。

### B-3. 共通 UI として用意する最小セット

- `Button`（§4.2）
- `Callout`（Message 置換、variant: info / success / warning / danger）
- `Tag`（記事タイプ表示など将来用）
- `LinkCard`（`.link-card` のコンポーネント化）
- `CopyButton`（`useEffect` DOM 挿入から脱却するとき）
- `IconLink`（Who ページのソーシャルリンク群）

---

以上。実装の変更があった場合はこのドキュメントを **必ず更新**すること。
