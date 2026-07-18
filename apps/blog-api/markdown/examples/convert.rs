//! 標準入力の Markdown を本番 (webhook upsert) と同じコンバータで HTML に変換して標準出力へ。
//! DB に保存済みの content_html を手元で再生成する用途。
//! 本番と同じ UreqFetcher で実 URL をフェッチするため、実行にはネットワークが必要。
//!
//! ```sh
//! cargo run -p markdown --example convert < article.md > article.html
//! ```
use std::io::Read;

use markdown::MarkdownConverter;

fn main() {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");
    let converter = MarkdownConverter::new();
    print!("{}", converter.convert(&input));
}
