# apps/web

shuntaka.dev の本番フロントエンド。Next.js 16 + React 19 + Tailwind CSS 4 + TypeScript。

## デザイン仕様 / カタログ

- **ブランドルール / Hard rules**: `./DESIGN.md`（voice、color、layout、iconography 全部）
- **視覚カタログ (Storybook)**: `bun run storybook` (main 既定 http://localhost:43005。worktree では `STORYBOOK_PORT`)。本番マージで GitHub Pages へ自動デプロイ
- **Token 実装**: `src/app/globals.css`（`:root` / `[data-theme='dark']`）

## 主要ディレクトリ

- `src/app/` — App Router（page.tsx、layout.tsx、globals.css）
- `src/components/` — Client/Server components（BaseLayout、ArticleCard、ToggleSwitch、TableOfContents 等）
- `src/lib/` — API client (`api.ts`)、定数 (`constants.ts`)
- `.storybook/` — Storybook 設定（main.ts、preview.tsx）と `*.stories.tsx`

## 開発コマンド

| 用途                 | コマンド                  |
| -------------------- | ------------------------- |
| 開発サーバー         | `bun run dev`             |
| 本番ビルド           | `bun run build`           |
| 型チェック           | `bun run type-check`      |
| Storybook 開発       | `bun run storybook`       |
| Storybook 静的ビルド | `bun run build-storybook` |

## ハードルール (要約 — 詳細は `DESIGN.md`)

- 単一アクセント色: `#e4007f`（`--color-accent`）。他のアクセントを増やさない
- グラデーション禁止、静止カードへの drop-shadow 禁止
- UI に絵文字を入れない（mascot `ochaIcon` フルカラー SVG のみが視覚的アクセント）
- 本文 line-height は `--lh-body`、見出し `--lh-heading`、リスト `--lh-list`（実値は `globals.css`）
- 日付は常に `YYYY/MM/DD`
- nav / tab ラベルは小文字（`posts`、`about`）
- Tailwind preset 色クラス（`bg-blue-500` 等）禁止 → CSS 変数を使う
- インライン `style={{ color: '#…' }}` 禁止

## 新しいコンポーネントを追加するとき

1. `src/components/Foo.tsx` に実装（既存コンポーネントの命名・props スタイルに揃える）
2. `src/components/Foo.stories.tsx` に Story を追加（最低 1 つ、できれば variant 別）
3. `globals.css` の既存トークン（`--color-*`、`--radius-*`、`--lh-*`、`--space-*` 等）から外れる値を入れない
4. `bun run type-check` と `bun run lint` を通す
