//! Storybook の記事ページ Story 用 HTML フィクスチャ生成。
//!
//! apps/web/src/components/__fixtures__/articleFullHtml.ts の生成元。
//! 本番と同じ UreqFetcher で実 URL をフェッチするため、実行にはネットワークが必要。
//!
//! ```sh
//! cargo run -p markdown --example storybook_fixture > /tmp/article_fixture.html
//! ```
use markdown::MarkdownConverter;

const MARKDOWN: &str = r##"この記事は Storybook 用のサンプル記事です。本文には **太字**、*斜体*、~~取り消し線~~、`inline code`、[外部リンク](https://zenn.dev)、[内部リンク](/shuntaka/articles/sample) といったインライン要素を含みます。

## テキストとリスト

- 箇条書きリスト
- 2 つ目の項目
  - ネストした項目

1. 番号付きリスト
2. 2 つ目の項目

- [x] 完了したタスク
- [ ] 未完了のタスク

## テーブルと引用

| 構成要素       | 技術        |
| -------------- | ----------- |
| フロントエンド | Next.js 16  |
| バックエンド   | Rust (Axum) |
| データベース   | TiDB        |

> 引用ブロックです。複数行にまたがる
> 引用のサンプルです。

---

## コードブロック

言語指定なし

```
ls -al
```

言語指定あり

```bash
ls -al
```

ファイル名あり

```bash:test
ls -al
```

シンタックスハイライト（rust）

```rust
fn main() {
    let converter = MarkdownConverter::new();
    println!("{}", converter.convert("# Hello"));
}
```

## メッセージ

:::message
デフォルトのメッセージです。補足情報や注意喚起に使います。
:::

:::message info
info メッセージです。
:::

:::message success
success メッセージです。
:::

:::message warning
warning メッセージです。
:::

:::message error
error メッセージです。
:::

## アコーディオン

:::details 実装の詳細を見る
折りたたみの中にも Markdown を書けます。

- リスト項目
- `inline code`

```bash
bun run storybook
```
:::

## 画像

![shuntaka.dev の OGP 画像](https://res.cloudinary.com/dkerzyk09/image/upload/v1767101809/blog/og/shuntaka.png)

## GitHub 埋め込み

1 行指定

https://github.com/shuntaka9576/shuntaka-dev/blob/main/apps/blog-api/api/src/handler/health.rs#L4

1 行指定 + plain

https://github.com/shuntaka9576/shuntaka-dev/blob/05f8f2556c4823a4d6f00558f207b7afb11cffb3/apps/blog-api/Makefile.toml?plain=1#L11

複数行指定

https://github.com/shuntaka9576/shuntaka-dev/blob/main/apps/blog-api/api/src/handler/health.rs#L4-L31

複数行指定 + plain

https://github.com/shuntaka9576/shuntaka-dev/blob/05f8f2556c4823a4d6f00558f207b7afb11cffb3/docs/source/01_development.md?plain=1#L227-L229

## リンクカード

https://shuntaka.dev
https://shuntaka.dev/shuntaka/articles/20251224-reflecting-on-2025
https://shuntaka.dev/shuntaka/articles/20260108-shuntaka-blog-rearchitecture

https://zenn.dev/shuntaka

https://zenn.dev/shuntaka/articles/shuntaka-github-cli-get-issues

https://github.com/zenn-dev/zenn-editor/pull/528

## X ポスト埋め込み

通常

https://x.com/shuntaka_jp/status/2005455430907216136

画像

https://x.com/shuntaka_jp/status/2006628407640244432

動画

https://x.com/shuntaka_jp/status/2005967665513554314

画像 + 引用

https://x.com/shuntaka_jp/status/2007325737725084022

引用 + 画像

https://x.com/shuntaka_jp/status/2007605987881169264

## SpeakerDeck 埋め込み

@[sd](ceec399cc51849d0889601c597dd030b,1,560/420,1.3)

## 脚注

本文中に脚注[^1]を書けます。名前付きの脚注[^note]や、リンクを含む脚注[^2]も使えます。

[^1]: 一つ目の脚注です。

[^note]: 名前付きの脚注です。

[^2]: [Zenn の脚注記法](https://zenn.dev/zenn/articles/markdown-guide#%E8%84%9A%E6%B3%A8) と同じ書き方です。
"##;

fn main() {
    let converter = MarkdownConverter::new();
    println!("{}", converter.convert(MARKDOWN));
}
