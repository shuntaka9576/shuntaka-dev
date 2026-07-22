// cspell:disable
/**
 * 記事ページ Story 用の HTML フィクスチャ。
 * apps/blog-api/markdown の実コンバータ出力そのまま（手で編集しない）。
 *
 * 再生成（ネットワーク必須。リポジトリルートで実行）:
 *   cargo run -p markdown --example storybook_fixture > /tmp/article_fixture.html
 * のうえで、このファイルのテンプレートリテラル部分を差し替える。
 */
export const ARTICLE_FULL_HTML = `<p>この記事は Storybook 用のサンプル記事です。本文には <strong>太字</strong>、<em>斜体</em>、<del>取り消し線</del>、<code>inline code</code>、<a href="https://zenn.dev" target="_blank" rel="noopener noreferrer">外部リンク</a>、<a href="/shuntaka/articles/sample">内部リンク</a> といったインライン要素を含みます。</p>
<h2 id="テキストとリスト"><a class="heading-anchor" href="#テキストとリスト" aria-label="この見出しへのリンクをコピー">#</a>テキストとリスト<a href="#テキストとリスト" aria-label="Link to heading 'テキストとリスト'" data-heading-content="テキストとリスト" class="anchor"></a></h2>
<ul>
<li>箇条書きリスト</li>
<li>2 つ目の項目
<ul>
<li>ネストした項目</li>
</ul>
</li>
</ul>
<ol>
<li>番号付きリスト</li>
<li>2 つ目の項目</li>
</ol>
<ul>
<li><input type="checkbox" checked="" disabled="" /> 完了したタスク</li>
<li><input type="checkbox" disabled="" /> 未完了のタスク</li>
</ul>
<h2 id="テーブルと引用"><a class="heading-anchor" href="#テーブルと引用" aria-label="この見出しへのリンクをコピー">#</a>テーブルと引用<a href="#テーブルと引用" aria-label="Link to heading 'テーブルと引用'" data-heading-content="テーブルと引用" class="anchor"></a></h2>
<table>
<thead>
<tr>
<th>構成要素</th>
<th>技術</th>
</tr>
</thead>
<tbody>
<tr>
<td>フロントエンド</td>
<td>Next.js 16</td>
</tr>
<tr>
<td>バックエンド</td>
<td>Rust (Axum)</td>
</tr>
<tr>
<td>データベース</td>
<td>TiDB</td>
</tr>
</tbody>
</table>
<blockquote>
<p>引用ブロックです。複数行にまたがる
引用のサンプルです。</p>
</blockquote>
<hr />
<h2 id="コードブロック"><a class="heading-anchor" href="#コードブロック" aria-label="この見出しへのリンクをコピー">#</a>コードブロック<a href="#コードブロック" aria-label="Link to heading 'コードブロック'" data-heading-content="コードブロック" class="anchor"></a></h2>
<p>言語指定なし</p>
<pre style="background-color:#2b303b;"><code><span style="color:#c0c5ce;">ls -al
</span></code></pre>
<p>言語指定あり</p>
<pre lang="bash" style="background-color:#2b303b;"><code><span style="color:#8fa1b3;">ls</span><span style="color:#bf616a;"> -al
</span></code></pre>
<p>ファイル名あり</p>
<div class="code-block-container"><div class="code-block-filename-container"><span class="code-block-filename">test</span></div><pre style="background-color:#2b303b;">
<span style="color:#8fa1b3;">ls</span><span style="color:#bf616a;"> -al</span></pre>
</div>
<p>シンタックスハイライト（rust）</p>
<pre lang="rust" style="background-color:#2b303b;"><code><span style="color:#b48ead;">fn </span><span style="color:#8fa1b3;">main</span><span style="color:#c0c5ce;">() {
</span><span style="color:#c0c5ce;">    </span><span style="color:#b48ead;">let</span><span style="color:#c0c5ce;"> converter = MarkdownConverter::new();
</span><span style="color:#c0c5ce;">    println!(&quot;</span><span style="color:#d08770;">{}</span><span style="color:#c0c5ce;">&quot;, converter.</span><span style="color:#96b5b4;">convert</span><span style="color:#c0c5ce;">(&quot;</span><span style="color:#a3be8c;"># Hello</span><span style="color:#c0c5ce;">&quot;));
</span><span style="color:#c0c5ce;">}
</span></code></pre>
<h2 id="メッセージ"><a class="heading-anchor" href="#メッセージ" aria-label="この見出しへのリンクをコピー">#</a>メッセージ<a href="#メッセージ" aria-label="Link to heading 'メッセージ'" data-heading-content="メッセージ" class="anchor"></a></h2>
<div class="message "><p>デフォルトのメッセージです。補足情報や注意喚起に使います。</p>
</div>
<div class="message info"><p>info メッセージです。</p>
</div>
<div class="message success"><p>success メッセージです。</p>
</div>
<div class="message warning"><p>warning メッセージです。</p>
</div>
<div class="message error"><p>error メッセージです。</p>
</div>
<h2 id="アコーディオン"><a class="heading-anchor" href="#アコーディオン" aria-label="この見出しへのリンクをコピー">#</a>アコーディオン<a href="#アコーディオン" aria-label="Link to heading 'アコーディオン'" data-heading-content="アコーディオン" class="anchor"></a></h2>
<details><summary>実装の詳細を見る</summary><div class="details-content"><p>折りたたみの中にも Markdown を書けます。</p>
<ul>
<li>リスト項目</li>
<li><code>inline code</code></li>
</ul>
<pre lang="bash" style="background-color:#2b303b;"><code><span style="color:#8fa1b3;">bun</span><span style="color:#c0c5ce;"> run storybook
</span></code></pre>
</div></details>
<h2 id="画像"><a class="heading-anchor" href="#画像" aria-label="この見出しへのリンクをコピー">#</a>画像<a href="#画像" aria-label="Link to heading '画像'" data-heading-content="画像" class="anchor"></a></h2>
<p><img src="https://res.cloudinary.com/dkerzyk09/image/upload/v1767101809/blog/og/shuntaka.png" alt="shuntaka.dev の OGP 画像" /></p>
<h2 id="github-埋め込み"><a class="heading-anchor" href="#github-埋め込み" aria-label="この見出しへのリンクをコピー">#</a>GitHub 埋め込み<a href="#github-埋め込み" aria-label="Link to heading 'GitHub 埋め込み'" data-heading-content="GitHub 埋め込み" class="anchor"></a></h2>
<p>1 行指定</p>
<div class="github-embed-card">
<div class="github-embed-header">
<div class="github-embed-info">
<div class="github-embed-row">
<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
<a href="https://github.com/shuntaka9576/shuntaka-dev/blob/main/apps/blog-api/api/src/handler/health.rs#L4" target="_blank" rel="noopener noreferrer" target="_blank" rel="noopener noreferrer">
<span class="github-embed-path">apps/blog-api/api/src/handler/health.rs</span>
</a>
<span class="github-embed-lines">L4</span>
</div>
<div class="github-embed-row">
<span class="github-embed-rev">main</span>
</div>
</div>
</div>
<div class="github-embed-code">
<pre style="background-color:#2b303b;">
<span style="color:#c0c5ce;">#[</span><span style="color:#bf616a;">utoipa</span><span style="color:#c0c5ce;">::</span><span style="color:#bf616a;">path</span><span style="color:#c0c5ce;">(</span></pre>
</div>
</div>
<p>1 行指定 + plain</p>
<div class="github-embed-card">
<div class="github-embed-header">
<div class="github-embed-info">
<div class="github-embed-row">
<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
<a href="https://github.com/shuntaka9576/shuntaka-dev/blob/05f8f2556c4823a4d6f00558f207b7afb11cffb3/apps/blog-api/Makefile.toml?plain=1#L11" target="_blank" rel="noopener noreferrer" target="_blank" rel="noopener noreferrer">
<span class="github-embed-path">apps/blog-api/Makefile.toml</span>
</a>
<span class="github-embed-lines">L11</span>
</div>
<div class="github-embed-row">
<span class="github-embed-rev">05f8f25</span>
</div>
</div>
</div>
<div class="github-embed-code">
<pre style="background-color:#2b303b;">
<span style="color:#c0c5ce;">] }</span></pre>
</div>
</div>
<p>複数行指定</p>
<div class="github-embed-card">
<div class="github-embed-header">
<div class="github-embed-info">
<div class="github-embed-row">
<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
<a href="https://github.com/shuntaka9576/shuntaka-dev/blob/main/apps/blog-api/api/src/handler/health.rs#L4-L31" target="_blank" rel="noopener noreferrer" target="_blank" rel="noopener noreferrer">
<span class="github-embed-path">apps/blog-api/api/src/handler/health.rs</span>
</a>
<span class="github-embed-lines">L4-L31</span>
</div>
<div class="github-embed-row">
<span class="github-embed-rev">main</span>
</div>
</div>
</div>
<div class="github-embed-code">
<pre style="background-color:#2b303b;">
<span style="color:#c0c5ce;">#[</span><span style="color:#bf616a;">utoipa</span><span style="color:#c0c5ce;">::</span><span style="color:#bf616a;">path</span><span style="color:#c0c5ce;">(
</span><span style="color:#c0c5ce;">    get,
</span><span style="color:#c0c5ce;">    path = &quot;</span><span style="color:#a3be8c;">/health</span><span style="color:#c0c5ce;">&quot;,
</span><span style="color:#c0c5ce;">    </span><span style="color:#8fa1b3;">responses</span><span style="color:#c0c5ce;">(
</span><span style="color:#c0c5ce;">        (status = 204, description = &quot;</span><span style="color:#a3be8c;">Service is healthy</span><span style="color:#c0c5ce;">&quot;)
</span><span style="color:#c0c5ce;">    ),
</span><span style="color:#c0c5ce;">    </span><span style="color:#bf616a;">tag </span><span style="color:#c0c5ce;">= &quot;</span><span style="color:#a3be8c;">health</span><span style="color:#c0c5ce;">&quot;
</span><span style="color:#c0c5ce;">)]
</span><span style="color:#b48ead;">pub</span><span style="color:#c0c5ce;"> async </span><span style="color:#b48ead;">fn </span><span style="color:#8fa1b3;">health_check</span><span style="color:#c0c5ce;">() -&gt; StatusCode {
</span><span style="color:#c0c5ce;">    StatusCode::</span><span style="color:#d08770;">NO_CONTENT
</span><span style="color:#c0c5ce;">}
</span><span style="color:#c0c5ce;">
</span><span style="color:#c0c5ce;">#[</span><span style="color:#bf616a;">utoipa</span><span style="color:#c0c5ce;">::</span><span style="color:#bf616a;">path</span><span style="color:#c0c5ce;">(
</span><span style="color:#c0c5ce;">    get,
</span><span style="color:#c0c5ce;">    path = &quot;</span><span style="color:#a3be8c;">/health/db</span><span style="color:#c0c5ce;">&quot;,
</span><span style="color:#c0c5ce;">    </span><span style="color:#8fa1b3;">responses</span><span style="color:#c0c5ce;">(
</span><span style="color:#c0c5ce;">        (status = 204, description = &quot;</span><span style="color:#a3be8c;">Database connection is healthy</span><span style="color:#c0c5ce;">&quot;),
</span><span style="color:#c0c5ce;">        (status = 500, description = &quot;</span><span style="color:#a3be8c;">Database connection failed</span><span style="color:#c0c5ce;">&quot;)
</span><span style="color:#c0c5ce;">    ),
</span><span style="color:#c0c5ce;">    </span><span style="color:#bf616a;">tag </span><span style="color:#c0c5ce;">= &quot;</span><span style="color:#a3be8c;">health</span><span style="color:#c0c5ce;">&quot;
</span><span style="color:#c0c5ce;">)]
</span><span style="color:#b48ead;">pub</span><span style="color:#c0c5ce;"> async </span><span style="color:#b48ead;">fn </span><span style="color:#8fa1b3;">health_check_db</span><span style="color:#c0c5ce;">(State(</span><span style="color:#bf616a;">registry</span><span style="color:#c0c5ce;">): State&lt;AppRegistry&gt;) -&gt; StatusCode {
</span><span style="color:#c0c5ce;">    </span><span style="color:#b48ead;">if</span><span style="color:#c0c5ce;"> registry.</span><span style="color:#96b5b4;">health_check_repository</span><span style="color:#c0c5ce;">().</span><span style="color:#96b5b4;">check_db</span><span style="color:#c0c5ce;">().await {
</span><span style="color:#c0c5ce;">        StatusCode::</span><span style="color:#d08770;">NO_CONTENT
</span><span style="color:#c0c5ce;">    } </span><span style="color:#b48ead;">else </span><span style="color:#c0c5ce;">{
</span><span style="color:#c0c5ce;">        StatusCode::</span><span style="color:#d08770;">INTERNAL_SERVER_ERROR
</span><span style="color:#c0c5ce;">    }
</span><span style="color:#c0c5ce;">}</span></pre>
</div>
</div>
<p>複数行指定 + plain</p>
<div class="github-embed-card">
<div class="github-embed-header">
<div class="github-embed-info">
<div class="github-embed-row">
<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
<a href="https://github.com/shuntaka9576/shuntaka-dev/blob/05f8f2556c4823a4d6f00558f207b7afb11cffb3/docs/source/01_development.md?plain=1#L227-L229" target="_blank" rel="noopener noreferrer" target="_blank" rel="noopener noreferrer">
<span class="github-embed-path">docs/source/01_development.md</span>
</a>
<span class="github-embed-lines">L227-L229</span>
</div>
<div class="github-embed-row">
<span class="github-embed-rev">05f8f25</span>
</div>
</div>
</div>
<div class="github-embed-code">
<pre style="background-color:#2b303b;">
<span style="color:#8fa1b3;">### dsql-cli
</span><span style="color:#c0c5ce;">
</span><span style="color:#c0c5ce;">PostgreSQLを起動</span></pre>
</div>
</div>
<h2 id="リンクカード"><a class="heading-anchor" href="#リンクカード" aria-label="この見出しへのリンクをコピー">#</a>リンクカード<a href="#リンクカード" aria-label="Link to heading 'リンクカード'" data-heading-content="リンクカード" class="anchor"></a></h2>
<div class="link-card-wrapper"><a href="https://shuntaka.dev" target="_blank" rel="noopener noreferrer" class="link-card" target="_blank" rel="noopener noreferrer"><div class="link-card-content"><div class="link-card-text"><div class="link-card-title">shuntaka.dev</div><div class="link-card-description">shuntaka.devは、技術・開発・ガジェットについてshuntakaが思ったことをシェアするブログです。</div></div><div class="link-card-image"><img src="https://res.cloudinary.com/dkerzyk09/image/upload/v1767101809/blog/og/shuntaka.png" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div></div><div class="link-card-footer"><img class="link-card-favicon" src="https://shuntaka.dev/icons/icon.png" alt="" onerror="this.style.display='none'"><span class="link-card-domain">shuntaka.dev</span></div></a></div>
<div class="link-card-wrapper"><a href="https://shuntaka.dev/shuntaka/articles/20251224-reflecting-on-2025" target="_blank" rel="noopener noreferrer" class="link-card" target="_blank" rel="noopener noreferrer"><div class="link-card-content"><div class="link-card-text"><div class="link-card-title">2025年の振り返り</div><div class="link-card-description">皆様2025年お疲れさまでした！毎年恒例の振り返りをしました！</div></div><div class="link-card-image"><img src="https://res.cloudinary.com/dkerzyk09/image/upload/v1767101809/blog/og/shuntaka.png" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div></div><div class="link-card-footer"><img class="link-card-favicon" src="https://shuntaka.dev/icons/icon.png" alt="" onerror="this.style.display='none'"><span class="link-card-domain">shuntaka.dev</span></div></a></div>
<div class="link-card-wrapper"><a href="https://shuntaka.dev/shuntaka/articles/20260108-shuntaka-blog-rearchitecture" target="_blank" rel="noopener noreferrer" class="link-card" target="_blank" rel="noopener noreferrer"><div class="link-card-content"><div class="link-card-text"><div class="link-card-title">Rust(axum) on Lambda × Aurora DSQL × Next.js on Vercelで個人ブログをリーアーキした話</div><div class="link-card-description">2020年にNode.js on Lambda × DynamoDB × Next.js on Vercelで運用していたブログのアーキテクチャを刷新しました！</div></div><div class="link-card-image"><img src="https://res.cloudinary.com/dkerzyk09/image/upload/s--z-0zbcS9--/c_fit,co_rgb:525457,l_text:notesansjpmid.otf_48_bold:Rust%28axum%29%20on%20Lambda%20%C3%97%20Aurora%20DSQL%20%C3%97%20Next.js%20on%20Vercel%E3%81%A7%E5%80%8B%E4%BA%BA%E3%83%96%E3%83%AD%E3%82%B0%E3%82%92%E3%83%AA%E3%83%BC%E3%82%A2%E3%83%BC%E3%82%AD%E3%81%97%E3%81%9F%E8%A9%B1,w_600/v1/blog/og/ogp.webp" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div></div><div class="link-card-footer"><img class="link-card-favicon" src="https://shuntaka.dev/icons/icon.png" alt="" onerror="this.style.display='none'"><span class="link-card-domain">shuntaka.dev</span></div></a></div>
<div class="link-card-wrapper"><a href="https://zenn.dev/shuntaka" target="_blank" rel="noopener noreferrer" class="link-card" target="_blank" rel="noopener noreferrer"><div class="link-card-content"><div class="link-card-text"><div class="link-card-title">shuntakaさんの記事一覧</div><div class="link-card-description">shuntakaさんのプロフィール</div></div><div class="link-card-image"><img src="https://static.zenn.studio/user-upload/avatar/0e4c51d31f.jpeg" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div></div><div class="link-card-footer"><img class="link-card-favicon" src="https://static.zenn.studio/images/logo-transparent.png" alt="" onerror="this.style.display='none'"><span class="link-card-domain">zenn.dev</span></div></a></div>
<div class="link-card-wrapper"><a href="https://zenn.dev/shuntaka/articles/shuntaka-github-cli-get-issues" target="_blank" rel="noopener noreferrer" class="link-card" target="_blank" rel="noopener noreferrer"><div class="link-card-content"><div class="link-card-text"><div class="link-card-title">GitHub Projectsに紐づくIssue一覧を取得する</div></div><div class="link-card-image"><img src="https://res.cloudinary.com/zenn/image/upload/s--3g4hSTU1--/c_fit%2Cg_north_west%2Cl_text:notosansjp-medium.otf_55:GitHub%2520Projects%25E3%2581%25AB%25E7%25B4%2590%25E3%2581%25A5%25E3%2581%258FIssue%25E4%25B8%2580%25E8%25A6%25A7%25E3%2582%2592%25E5%258F%2596%25E5%25BE%2597%25E3%2581%2599%25E3%2582%258B%2Cw_1010%2Cx_90%2Cy_100/g_south_west%2Cl_text:notosansjp-medium.otf_37:shuntaka%2Cx_203%2Cy_121/g_south_west%2Ch_90%2Cl_fetch:aHR0cHM6Ly9zdGF0aWMuemVubi5zdHVkaW8vdXNlci11cGxvYWQvYXZhdGFyLzBlNGM1MWQzMWYuanBlZw==%2Cr_max%2Cw_90%2Cx_87%2Cy_95/v1627283836/default/og-base-w1200-v2.png?_a=BACMTiAE" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div></div><div class="link-card-footer"><img class="link-card-favicon" src="https://static.zenn.studio/images/logo-transparent.png" alt="" onerror="this.style.display='none'"><span class="link-card-domain">zenn.dev</span></div></a></div>
<div class="link-card-wrapper"><a href="https://github.com/zenn-dev/zenn-editor/pull/528" target="_blank" rel="noopener noreferrer" class="link-card" target="_blank" rel="noopener noreferrer"><div class="link-card-content"><div class="link-card-text"><div class="link-card-title">feat: SpeakerDeck埋め込み要素にスライド番号のサポートを追加 by shuntaka9576 · Pull Request ...</div><div class="link-card-description">📑 Summary
#527
この記法でSpeakerDeckで表示したいスライドの番号を指定し、表示します。
@[speakerdeck](f005615e42d84c9b8bdb7fd722cbb...</div></div><div class="link-card-image"><img src="https://opengraph.githubassets.com/ad0bc4a3380f0940d2e82cce8f544cb2b51eae79ef186b2ac3b2dfb6333da8c4/zenn-dev/zenn-editor/pull/528" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div></div><div class="link-card-footer"><img class="link-card-favicon" src="https://github.githubassets.com/favicons/favicon.svg" alt="" onerror="this.style.display='none'"><span class="link-card-domain">github.com</span></div></a></div>
<h2 id="x-ポスト埋め込み"><a class="heading-anchor" href="#x-ポスト埋め込み" aria-label="この見出しへのリンクをコピー">#</a>X ポスト埋め込み<a href="#x-ポスト埋め込み" aria-label="Link to heading 'X ポスト埋め込み'" data-heading-content="X ポスト埋め込み" class="anchor"></a></h2>
<p>通常</p>
<div data-tweet-id="2005455430907216136"></div>
<p>画像</p>
<div data-tweet-id="2006628407640244432"></div>
<p>動画</p>
<div data-tweet-id="2005967665513554314"></div>
<p>画像 + 引用</p>
<div data-tweet-id="2007325737725084022"></div>
<p>引用 + 画像</p>
<div data-tweet-id="2007605987881169264"></div>
<h2 id="speakerdeck-埋め込み"><a class="heading-anchor" href="#speakerdeck-埋め込み" aria-label="この見出しへのリンクをコピー">#</a>SpeakerDeck 埋め込み<a href="#speakerdeck-埋め込み" aria-label="Link to heading 'SpeakerDeck 埋め込み'" data-heading-content="SpeakerDeck 埋め込み" class="anchor"></a></h2>
<div class="block-embed-service-speakerdeck"><iframe class="speakerdeck-iframe" frameborder="0" src="https://speakerdeck.com/player/ceec399cc51849d0889601c597dd030b?slide=1" allowfullscreen="true" style="border: 0px; background: padding-box padding-box rgba(0, 0, 0, 0.1); margin: 0px; padding: 0px; border-radius: 6px; box-shadow: rgba(0, 0, 0, 0.2) 0px 5px 40px; width: 100%; height: auto; aspect-ratio: 560/420;" data-ratio="1.3"></iframe></div>
<h2 id="脚注"><a class="heading-anchor" href="#脚注" aria-label="この見出しへのリンクをコピー">#</a>脚注<a href="#脚注" aria-label="Link to heading '脚注'" data-heading-content="脚注" class="anchor"></a></h2>
<p>本文中に脚注<sup class="footnote-ref"><a href="#fn-1" id="fnref-1" data-footnote-ref>1</a></sup>を書けます。名前付きの脚注<sup class="footnote-ref"><a href="#fn-note" id="fnref-note" data-footnote-ref>2</a></sup>や、リンクを含む脚注<sup class="footnote-ref"><a href="#fn-2" id="fnref-2" data-footnote-ref>3</a></sup>も使えます。</p>
<section class="footnotes" data-footnotes>
<span class="footnotes-title">脚注</span>
<ol>
<li id="fn-1">
<p>一つ目の脚注です。 <a href="#fnref-1" class="footnote-backref" data-footnote-backref data-footnote-backref-idx="1" aria-label="Back to reference 1">↩︎</a></p>
</li>
<li id="fn-note">
<p>名前付きの脚注です。 <a href="#fnref-note" class="footnote-backref" data-footnote-backref data-footnote-backref-idx="2" aria-label="Back to reference 2">↩︎</a></p>
</li>
<li id="fn-2">
<p><a href="https://zenn.dev/zenn/articles/markdown-guide#%E8%84%9A%E6%B3%A8" target="_blank" rel="noopener noreferrer">Zenn の脚注記法</a> と同じ書き方です。 <a href="#fnref-2" class="footnote-backref" data-footnote-backref data-footnote-backref-idx="3" aria-label="Back to reference 3">↩︎</a></p>
</li>
</ol>
</section>`;
