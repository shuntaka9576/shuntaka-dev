# 2026-04-25: apps/web デザインシステム整備

## 概要

`apps/web` フロントエンド（Next.js 16 + React 19 + Tailwind CSS 4）の色・タイポ・スペーシング・コンポーネント命名のばらつきを解消するため、デザインシステム（`apps/web/DESIGN.md`）を整備したうえで、それに沿って既存コードを段階的に整合化した。

## 背景

- 初期実装でフロントエンドの一貫性が不足していた。`bg-blue-500` のような Tailwind プリセット色直書き、`style={{ backgroundColor: '#xxx' }}` のインライン色、`max-w-[1200px]` / `pb-[58px]` のような任意値が散在。
- AI コーディングエージェントが新規 UI を作るときの規範が無いため、生成のたびに揺れが出る。
- VoltAgent/awesome-design-md / Stitch DESIGN.md 形式に準拠した `apps/web/DESIGN.md` を整備。本リファクタはそこで定義したセマンティックトークンと Do/Don't に既存コードを寄せる作業。

## ガイドラインの要点（`apps/web/DESIGN.md` 参照）

- 色は `--color-*` セマンティックトークン経由（直接 hex / Tailwind プリセット色禁止）
- レイアウト値は `--layout-*` / `--space-*` / `--radius-*` トークン経由（任意値禁止）
- ブランドアクセントはマゼンタピンク `#e4007f`（`--color-accent`）
- ダークモードは `data-theme` 属性 + `prefers-color-scheme` フォールバック
- ブレークポイントは Tailwind v4 のデフォルト min-width（`sm 640 / md 768 / lg 1024 / xl 1280`）
- 全 interactive 要素に `:focus-visible` の共通アウトライン（`var(--color-accent)`）

## 修正内容

### 1. CSS トークンの整備（`apps/web/src/app/globals.css`）

`:root` および `[data-theme='dark']` にセマンティックトークン群を追加。既存 `--tag-*` / `--message-*` / `--article-*` / `--header-*` / `--bg-*` は互換のため残し、新トークンからエイリアスする。

| カテゴリ     | 追加トークン                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 色           | `--color-bg` / `--color-surface` / `--color-surface-raised` / `--color-text` / `--color-text-muted` / `--color-border` / `--color-border-subtle` / `--color-accent` / `--color-link` / `--color-link-hover` / `--color-link-visited` / `--color-code-inline-{bg,fg}` / `--color-code-block-{bg,fg}` / `--color-{info,success,warning,danger}-{bg,border}` / `--color-progress` / `--color-toggle-{moon,sun}` |
| スペーシング | `--space-1..10`（4px 基点）                                                                                                                                                                                                                                                                                                                                                                                  |
| 角丸         | `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-full`                                                                                                                                                                                                                                                                                                                                              |
| レイアウト   | `--layout-max` / `--layout-list-max` / `--layout-sidebar-w` / `--layout-header-h` / `--layout-nav-h` / `--layout-footer-h`                                                                                                                                                                                                                                                                                   |
| モーション   | `--motion-fast` / `--motion-base` / `--motion-slow`                                                                                                                                                                                                                                                                                                                                                          |

### 2. アクセシビリティ

- `:is(a, button, [role='button'], input, select, textarea, summary):focus-visible` の共通フォーカスリングを `globals.css` に追加（全 interactive 要素）。

### 3. コードブロック / プログレスバーの整合化

| 対象                                     | 修正                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `globals.css` `.prose pre`               | `#1e1e1e` / `#d4d4d4` ハードコード → `var(--color-code-block-bg)` / `var(--color-code-block-fg)`                                       |
| `globals.css` `#nprogress .bar` / `.peg` | `#29d` を `--color-progress` トークン経由に統一（色は元のシアンのまま、ダークモード考慮の改色は別タスク）                              |
| `globals.css` `.message`                 | `.message.info` / `.message.success` / `.message.warning` バリアントを新規追加。既存 `.message.error` も `--color-danger-*` 参照に整理 |
| `globals.css` `.article-title` モバイル  | `font-weight: 530`（マジックナンバー）→ `700`                                                                                          |

### 4. レイアウト値のトークン化

| 対象                                                                                                                   | 修正                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BaseLayout.tsx`                                                                                                       | `max-w-[1200px]` → `max-w-[var(--layout-max)]` / `pb-[58px]` → `pb-[var(--layout-footer-h)]` / `px-[2%]` → `px-4` / `style={{ background: 'var(...) }}` → クラス化  |
| `page.tsx` / `type/note/page.tsx` / `loading.tsx` / `type/note/loading.tsx` / `[userName]/articles/[slug]/loading.tsx` | `max-w-[600px]` → `max-w-[var(--layout-list-max)]`、スケルトンの `style={{ background: 'var(--article-area-color)' }}` → `bg-[var(--color-surface)]`                |
| `globals.css` `.right-sidebar`                                                                                         | `width: 296px` → `width: var(--layout-sidebar-w)`                                                                                                                   |
| `globals.css` `.article-content`                                                                                       | `width: calc(100% - 312px)` → `width: calc(100% - var(--layout-sidebar-w) - var(--space-4))`                                                                        |
| `globals.css` `.toc`                                                                                                   | `top: 112px` → `top: calc(var(--layout-header-h) + var(--layout-nav-h) + var(--space-5))`、`max-width: 296px` / `border-radius: 10px` / `padding: 8px` もトークン化 |

### 5. プリセット色 / インラインスタイルの撤廃

| ファイル                                   | Before                                                       | After                                 |
| ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------- |
| `app/error.tsx`                            | `bg-blue-500 hover:bg-blue-600 text-white` ボタン直書き      | `<Button variant="primary">` に置換   |
| `app/[userName]/articles/[slug]/error.tsx` | 同上                                                         | 同上                                  |
| `app/page.tsx` / `app/type/note/page.tsx`  | `text-red-500`                                               | `text-[var(--color-danger-border)]`   |
| `app/not-found.tsx`                        | `text-gray-600`                                              | `text-[var(--color-text-muted)]`      |
| `components/ArticleCard.tsx`               | `style={{ borderColor: 'var(--article-record-underline)' }}` | `border-[var(--color-border-subtle)]` |

### 6. 新規コンポーネント

- **`apps/web/src/components/Button.tsx`** を新規追加。
  - variant: `primary` / `secondary` / `ghost` / `danger`、size: `sm` / `md` / `lg`、`loading` 対応（スピナー + `aria-busy`）。
  - 依存追加なし（`clsx` / `cva` / `tailwind-merge` 不使用）。
  - エラーページのボタンを置換した。

### 7. その他

- `ArticleContent.tsx`: `<div className="prose prose-lg max-w-none">` → `<div className="prose max-w-none">`。`@tailwindcss/typography` プラグイン未導入で `prose-lg` が無効だったため除去。
- `cspell.json`: 新ドキュメントで使用する固有名詞 `Cantarell` / `Consolas` / `Fira` / `Menlo` / `Neue` / `Noto` / `Segoe` / `WCAG` を辞書登録。
- `CLAUDE.md`: `## Documentation` 節に `apps/web/DESIGN.md` への参照を 1 行追記。

## 差し戻し（壊れたため revert したもの）

| 対象                                         | 原因                                                                                                                                                                                              | 結果                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ToggleSwitch` の CSS 変数化 / 44×44 化      | `.toggle-switch` を 44×44 タッチターゲット化したところ `.dark-icon` の `position: absolute` の基準が変わって月アイコンがラベル外に飛んだ。`::before` での hit area 拡張案も見た目に違和感が残った | `apps/web/src/components/ToggleSwitch.tsx` と `globals.css` の `.toggle-switch` / `.toggle-label` / `.dark-icon` を **元の実装に完全差し戻し**。リデザインとセットで別タスク化 |
| NProgress バー色 (`#29d` → `--color-accent`) | 元のシアン色を期待していたユーザー指摘                                                                                                                                                            | `--color-progress: #29d` トークンを新設して元のシアンに戻した                                                                                                                  |

## 検証

- `bun run lint` 通過（`vp lint` / `vp fmt` / `cspell` / `tsc --noEmit` すべて成功）
- `bun run type-check` 通過（`@shuntaka-dev/web` / `@shuntaka-dev/aws`）
- `bun run build` のコンパイル + TypeScript フェーズは成功（`/sitemap.xml` の prerender は API サーバー未稼働のため失敗、本リファクタとは無関係）

## 残課題

`apps/web/DESIGN.md` 付録 A の ⏳ ステータス項目を参照。主要なものは下記。

| 項目                                                           | 理由                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Noto_Sans_JP({ subsets: ['latin'] })` のサブセット見直し      | フォント挙動への影響が読み切れないため別タスク                       |
| `globals.css` 見出しを `em` → `rem` に統一                     | 全記事の見栄えに影響するため段階導入                                 |
| リスト / メッセージ / 記事ラッパ等の細かいマージン正規化       | 微差調整のため段階導入                                               |
| `ArticleContent.tsx` のコピーボタン `useEffect` DOM 挿入       | API 側で `<button>` を同梱する形に移すのが本筋。当面は現状動作で許容 |
| `.github-embed-copy` / `.code-block-copy` / `.copy-btn` の統一 | 埋め込み HTML 側との同時改修要                                       |
| `ToggleSwitch` のリデザイン                                    | 上記差し戻しを引き取り、トークン化と 44×44 タッチターゲットを再設計  |

## 参照

- 設計書本体: `apps/web/DESIGN.md`
- セマンティックトークン定義: `apps/web/src/app/globals.css` `:root` / `[data-theme='dark']`
- 共通ボタン: `apps/web/src/components/Button.tsx`
