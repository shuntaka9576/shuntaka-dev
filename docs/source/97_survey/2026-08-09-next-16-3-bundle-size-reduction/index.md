<!-- cspell:ignore Turbopack first-load client-browser moduleFactories PostCSS -->

# Next.js 16.3 更新でクライアント JS が 104 KiB 減った理由

- 対象: `apps/web`（Next.js 16.2.11 → 16.3.0、Turbopack production build）
- 調査日: 2026-08-09
- きっかけ: [PR #748](https://github.com/shuntaka9576/shuntaka-dev/pull/748) の Bundle Size report で大幅な減少を検出した

## 結論

Bundle Size report の減少は、ISR、`use cache`、Partial Prefetching への移行でアプリコードが減ったためではない。**Next.js 16.3に含まれるTurbopackのclient bundle修正がほぼ全量を占める**。

主因は次の2点だった。

1. Next.js 16.2.11では、本来ブラウザに不要な`next/dist/server`配下の実装がclient bundleへ混入していた。16.3のbrowser variant分離で解消され、共有JSを約56 KiB削減した
2. 16.2.11では同じ19モジュールを並び順だけ変えて持つ24.3 KiBのチャンクが3ファイル生成されていた。16.3のモジュール順序正規化で同一チャンクとして扱われ、余分な2ファイル、計48.6 KiBが消えた

概算すると、CIで観測したTotal unique JSの削減は次の内訳で説明できる。

```text
104.3 KiB減 ≒ server-onlyコード・runtimeの削減 55.7 KiB
              + 重複チャンク2ファイルの削減 48.6 KiB
```

## CIで観測した変化

[Bundle Size report](https://github.com/shuntaka9576/shuntaka-dev/pull/748#issuecomment-5214304370) は、`TURBOPACK_STATS=1`で生成した`route-bundle-stats.json`と実チャンクの非圧縮サイズを比較している。

| 指標                     | Base (16.2.11) | PR (16.3.0) |                差分 |
| ------------------------ | -------------: | ----------: | ------------------: |
| 全ルート共通JS           |      547.1 KiB |   490.3 KiB |  -56.8 KiB (-10.4%) |
| 全ルートのユニークJS合計 |      649.1 KiB |   544.7 KiB | -104.3 KiB (-16.1%) |

ルート固有JSは、全ルート共通チャンクを除いた残りである。

| ルート                        |     Base |       PR |               差分 |
| ----------------------------- | -------: | -------: | -----------------: |
| `/`, `/page/[page]`           | 56.9 KiB | 32.5 KiB | -24.4 KiB (-42.8%) |
| `/[userName]/articles/[slug]` | 33.4 KiB | 10.2 KiB | -23.1 KiB (-69.4%) |
| `/about`                      | 28.8 KiB |  4.5 KiB | -24.3 KiB (-84.3%) |
| `/moments`                    |  6.9 KiB |  6.8 KiB |       ほぼ変化なし |
| `/moments/preview`            |  0.3 KiB |  0.3 KiB |           変化なし |

`/about`の`-84.3%`は、ページ全体のfirst-load JSが84.3%減ったという意味ではない。共通JSを足した実質的なfirst-loadは約575.9 KiBから494.8 KiBへの減少で、約14.1%減となる。大きな割合に見えるのは、小さいルート固有部分から24.3 KiBの重複チャンクが丸ごと消えたためである。

## バージョン更新とアプリ変更の切り分け

Base commit `88521c7`とPR head `7f8d62d`をworktreeに分け、同じAPIスタブ、同じ環境変数でproduction buildした。さらに、Baseのソースと設定を維持したまま`next`と`@next/env`だけ16.3.0へ更新した中間条件を用意した。

```console
TURBOPACK_STATS=1 \
  NEXT_PUBLIC_API_URL=http://localhost:43008 \
  bun run build
```

| 条件                                 |    共有JS | ユニークJS合計 |      16.2.11からの差分 |
| ------------------------------------ | --------: | -------------: | ---------------------: |
| Baseソース + Next.js 16.2.11         | 547.0 KiB |      649.0 KiB |                      — |
| Baseソース + Next.js 16.3.0のみ      | 488.8 KiB |      543.3 KiB | -58.3 KiB / -105.7 KiB |
| PR全体（Cache Components移行を含む） | 490.3 KiB |      544.7 KiB | -56.7 KiB / -104.2 KiB |

Next.jsだけを更新した時点で、PR全体よりわずかに小さくなっている。PRのアプリ・設定変更を加えると、16.3.0単純更新時より共有JSが1.5 KiB、ユニークJS合計が1.4 KiB増えた。したがって、今回の大幅削減を`use cache`や`partialPrefetching`の効果として説明することはできない。

CIはLinux、切り分けはmacOSで実行したため、丸め前の値には0.1 KiB程度の差がある。削減量とチャンク構造は一致した。

## 原因1: Server側実装のclient bundle混入が解消された

Next.js公式のTurbopack Bundle Analyzerを両バージョンで実行し、client outputに含まれるソースモジュールを比較した。

```console
bunx next experimental-analyze --output
```

16.2.11では次のServer側モジュールがclient outputに含まれていたが、16.3.0では0になった。表はAnalyzer上の非圧縮サイズで、上位6件だけで51.8 KiBある。

| 16.2.11でclient outputに入っていたモジュール                        |   削減量 |
| ------------------------------------------------------------------- | -------: |
| `next/dist/server/app-render/dynamic-rendering.js`                  | 20.8 KiB |
| `next/dist/server/request/params.js`                                |  7.9 KiB |
| `next/dist/server/request/search-params.js`                         |  7.4 KiB |
| `next/dist/server/app-render/instant-validation/instant-samples.js` |  6.6 KiB |
| `next/dist/compiled/@edge-runtime/cookies/index.js`                 |  4.8 KiB |
| `next/dist/server/app-render/staged-rendering.js`                   |  4.2 KiB |

Analyzerのclient JS全体では730,302 bytesから673,264 bytesへ、57,038 bytes（55.7 KiB）減った。新しいnavigation実装の増加分を含めても、Server側コードの除去が上回っている。

これはNext.js 16.3の次の修正と一致する。

- [#95201 Split typeof-window server requires into .browser variants](https://github.com/vercel/next.js/pull/95201): PR本文で「recent bundle size regressions」の修正と説明されている
- [#95366 Split remaining "client-node"-only modules into .browser variants](https://github.com/vercel/next.js/pull/95366): `next/src/server`がclient-browser bundleへ入るregressionを解消している
- [#95200 Collect modules with browser variants statically](https://github.com/vercel/next.js/pull/95200): `.browser` siblingを自動検出し、browser向けmodule aliasを生成する

## 原因2: 同一モジュール集合の重複チャンクが統合された

16.2.11のproduction artifactには、いずれも24,878 bytesで、**同じ19個のmodule factoryを持つチャンクが3ファイル**あった。差はmodule factoryの並び順だけだった。

- 1ファイルは全ルート共通チャンク
- 1ファイルは`/`と`/page/[page]`が追加ロード
- 1ファイルは記事詳細と`/about`が追加ロード

つまり、該当ルートは同じモジュール集合を共有チャンクとルート固有チャンクから二重に受け取っていた。また、ユニークJS合計では同内容の余分な2ファイルを別ファイルとして数えていた。

16.3.0ではこの2ファイルが消えた。

- 各該当ルート: 約24.3 KiB減
- ユニークJS合計: `24,878 bytes × 2 = 49,756 bytes`、約48.6 KiB減

これは[#94961 Sort modules in chunks to reduce duplicates](https://github.com/vercel/next.js/pull/94961)の修正内容と一致する。Turbopackが同じchunk item集合を異なる順番で配置するとcontent hashが変わり、重複ファイルとして配信される問題に対し、module順を正規化して同じファイル名へ収束させている。

## 小さい要因: Turbopack runtime自体の縮小

Next.js 16.3の公式記事にも[Smaller runtime size](https://nextjs.org/blog/next-16-3-turbopack#smaller-runtime-size)として、WebAssembly、Worker、top-level async用コードを必要な場合だけ配信する変更が記載されている。

このアプリの`turbopack-*.js`は10,580 bytesから9,652 bytesへ928 bytes（約0.9 KiB）減った。改善は確認できるが、104.3 KiB削減の主因ではない。

対応するupstream PRは次のとおり。

- [#94376 Only ship top-level async support in the runtime when needed](https://github.com/vercel/next.js/pull/94376)
- [#94372 Remove worker helpers from the default runtime](https://github.com/vercel/next.js/pull/94372)
- [#94373 Remove WebAssembly helpers from the default runtime](https://github.com/vercel/next.js/pull/94373)

## ISR / Partial Prefetchingとの関係

今回のPRで導入したCache Components、`use cache`、`cacheLife`、Partial Prefetchingは、再生成、キャッシュ、navigation時のshell配信を改善する。一方、上のA/B結果では、それらを入れる前のNext.js 16.3.0単純更新だけで削減が完了している。

したがって、同じアップデートで次の2種類の改善が同時に得られたが、原因は分けて考える必要がある。

- ISR / navigation改善: Cache ComponentsとPartial Prefetchingの新しい実行モデル
- client bundle削減: Turbopackのbrowser variant分離、重複チャンク除去、runtime縮小

## 計測上の注意

- Bundle Size reportは非圧縮JSを計測している。gzip / Brotli後の転送量やJavaScript実行時間を直接表すものではない
- `Shared JS`は全ルートのチャンク集合の積集合、`Total unique JS`は和集合、ルート固有JSは共有集合を除いた値である。Turbopackのre-chunkingにより共有・固有の分類は変わり得る
- `route-bundle-stats.json`のファイルサイズ比較とBundle Analyzerのmodule内訳は役割が異なる。前者をCIの判定値、後者を原因特定に使用した
- チャンク名はcontent hashなので環境やbuildで変わる。今回の根拠はファイル名ではなく、サイズ、route参照関係、module factory集合で確認した

## 参考

- [Next.js 16.3](https://nextjs.org/blog/next-16-3)
- [Turbopack: What's New in Next.js 16.3](https://nextjs.org/blog/next-16-3-turbopack)
- [Next.js v16.3.0 release notes](https://github.com/vercel/next.js/releases/tag/v16.3.0)
- [PR #748 Bundle Size report](https://github.com/shuntaka9576/shuntaka-dev/pull/748#issuecomment-5214304370)
