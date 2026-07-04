-- 既存記事へのタグ付与 backfill SQL（2026-07-05 article-tags タスク）
-- 生成元: 2026-07-05-article-tags.ts（MAPPING が正）。手で編集しない
-- 冪等 (INSERT IGNORE)。slug ベースなので blog_dev / blog_prd 共用。
-- 適用: mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA < 2026-07-05-article-tags.sql

-- 1. ルートタグ
INSERT IGNORE INTO tags (name) VALUES ('tech'), ('misc');

-- 2. 2階層目のタグ（親を逆引きして紐付け）
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'next.js', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'react', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'aws', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '振り返り', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'neovim', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'go', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'typescript', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'npm', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'モノレポ', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'github', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'oauth', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '開発環境', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'gcp', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'cdn', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'iot', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'mqtt', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'セキュリティ', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'jwt', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'cloudflare', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'dns', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'cli', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'arduino', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'deepl', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'rust', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'wasm', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'figma', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'tailwindcss', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'css', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'イベント参加', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'zig', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '登壇', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'キャリア', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '開発生産性', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'devops', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '読書', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '散歩', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'javascript', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'node.js', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'deno', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'denops', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'youtube', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'cloudinary', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '料理', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '引っ越し', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'コミュニケーション', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '健康', tag_id FROM tags WHERE name = 'misc';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'nix', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'raspberry-pi', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'kubernetes', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '技術メモ', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'mcp', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'postgresql', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'bun', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'macos', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'tauri', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'github-actions', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT '関数型プログラミング', tag_id FROM tags WHERE name = 'tech';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'tidb', tag_id FROM tags WHERE name = 'tech';

-- 3. 3階層目のタグ（親を逆引きして紐付け）
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'dynamodb', tag_id FROM tags WHERE name = 'aws';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'lambda', tag_id FROM tags WHERE name = 'aws';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'cdk', tag_id FROM tags WHERE name = 'aws';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 's3', tag_id FROM tags WHERE name = 'aws';

-- 4. 記事とタグの関連（leaf のみに張る。slug が無い環境では 0 行 insert）
-- 01esxf9w62kx10wfbg8888pqrp: tech/next.js, tech/react, tech/aws/dynamodb
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('next.js', 'react', 'dynamodb')
  WHERE a.slug = '01esxf9w62kx10wfbg8888pqrp';
-- 01etqfnfw9h98gffzbqsv4r32w: misc/振り返り, tech/neovim, tech/next.js, tech/go
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'neovim', 'next.js', 'go')
  WHERE a.slug = '01etqfnfw9h98gffzbqsv4r32w';
-- 01ev3p1knggn1wwsg0n0e98915: tech/typescript, tech/npm, tech/モノレポ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('typescript', 'npm', 'モノレポ')
  WHERE a.slug = '01ev3p1knggn1wwsg0n0e98915';
-- 01evbw029qzxavp20erstgvm5r: tech/typescript, tech/npm, tech/モノレポ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('typescript', 'npm', 'モノレポ')
  WHERE a.slug = '01evbw029qzxavp20erstgvm5r';
-- 01ezm5k2rt1jm6zbsewm33r0xw: tech/github, tech/oauth, tech/typescript
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('github', 'oauth', 'typescript')
  WHERE a.slug = '01ezm5k2rt1jm6zbsewm33r0xw';
-- 01f07hctzhjcwtdq4h6ew9stk8: tech/next.js, tech/aws/lambda, tech/aws/dynamodb, tech/github
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('next.js', 'lambda', 'dynamodb', 'github')
  WHERE a.slug = '01f07hctzhjcwtdq4h6ew9stk8';
-- 01f0n3x0afc5wt54qeaz77zvw4: tech/neovim, tech/typescript, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('neovim', 'typescript', '開発環境')
  WHERE a.slug = '01f0n3x0afc5wt54qeaz77zvw4';
-- 01f2wwqs2jcdgc7fh8bmhnewk6: tech/gcp, tech/next.js, tech/cdn
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('gcp', 'next.js', 'cdn')
  WHERE a.slug = '01f2wwqs2jcdgc7fh8bmhnewk6';
-- 01f3qsp7vz8dtetg5cq27ercna: tech/next.js, tech/react, tech/typescript
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('next.js', 'react', 'typescript')
  WHERE a.slug = '01f3qsp7vz8dtetg5cq27ercna';
-- 01f4gnep6herhgy449er48g9c0: tech/iot, tech/aws, tech/mqtt, tech/セキュリティ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('iot', 'aws', 'mqtt', 'セキュリティ')
  WHERE a.slug = '01f4gnep6herhgy449er48g9c0';
-- 01f4xw3pwm7tcrdswyzqsft5zs: tech/セキュリティ, tech/jwt, tech/oauth
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('セキュリティ', 'jwt', 'oauth')
  WHERE a.slug = '01f4xw3pwm7tcrdswyzqsft5zs';
-- 01fcexkj03t5wr0hkjt37t7dcz: tech/cloudflare, tech/dns
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('cloudflare', 'dns')
  WHERE a.slug = '01fcexkj03t5wr0hkjt37t7dcz';
-- 01fcg0jjyv4qmhg4n8r9hmcfds: tech/cloudflare, tech/dns, tech/cli
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('cloudflare', 'dns', 'cli')
  WHERE a.slug = '01fcg0jjyv4qmhg4n8r9hmcfds';
-- 01fe7z6p0rwwyjq90gkgcbm9nc: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '01fe7z6p0rwwyjq90gkgcbm9nc';
-- 01ffj5r74ykepbn4ae7eymdzs1: tech/iot, tech/aws, tech/arduino, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('iot', 'aws', 'arduino', '開発環境')
  WHERE a.slug = '01ffj5r74ykepbn4ae7eymdzs1';
-- 01ffwa0x782te58803721b1czg: tech/neovim, tech/arduino, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('neovim', 'arduino', '開発環境')
  WHERE a.slug = '01ffwa0x782te58803721b1czg';
-- 01fg0ayqeqbf4rbfzc7gev1t0k: tech/iot, tech/arduino, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('iot', 'arduino', '開発環境')
  WHERE a.slug = '01fg0ayqeqbf4rbfzc7gev1t0k';
-- 01fgdc0bawyb6d34gs54vxgpg9: tech/iot, tech/aws, tech/arduino, tech/mqtt
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('iot', 'aws', 'arduino', 'mqtt')
  WHERE a.slug = '01fgdc0bawyb6d34gs54vxgpg9';
-- 01fhkmja03z60ty39pkjnhv1e5: tech/typescript, tech/github, tech/cli
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('typescript', 'github', 'cli')
  WHERE a.slug = '01fhkmja03z60ty39pkjnhv1e5';
-- 01fmzy00fzvq736j42pa1jgnm5: tech/deepl, tech/cli
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('deepl', 'cli')
  WHERE a.slug = '01fmzy00fzvq736j42pa1jgnm5';
-- 01fppard9e05j9j9q6mh7w91pr: tech/rust, tech/wasm, tech/npm, tech/モノレポ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('rust', 'wasm', 'npm', 'モノレポ')
  WHERE a.slug = '01fppard9e05j9j9q6mh7w91pr';
-- 01fqn7vgp6hcejnyhe6k0fs208: misc/振り返り, tech/neovim, tech/iot
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'neovim', 'iot')
  WHERE a.slug = '01fqn7vgp6hcejnyhe6k0fs208';
-- 01fqtbggce9a5g9efzf83rvydy: tech/figma, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('figma', '開発環境')
  WHERE a.slug = '01fqtbggce9a5g9efzf83rvydy';
-- 01ftj8hr48t31sea0ed6vkzvhw: tech/tailwindcss, tech/css, tech/react
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('tailwindcss', 'css', 'react')
  WHERE a.slug = '01ftj8hr48t31sea0ed6vkzvhw';
-- 01fvkbeq00ejdq4xe38a7ccfb0: tech/react, tech/tailwindcss
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('react', 'tailwindcss')
  WHERE a.slug = '01fvkbeq00ejdq4xe38a7ccfb0';
-- 01fvpj77522jpcagxsget1ejqr: tech/oauth, tech/cloudflare, tech/セキュリティ, tech/typescript
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('oauth', 'cloudflare', 'セキュリティ', 'typescript')
  WHERE a.slug = '01fvpj77522jpcagxsget1ejqr';
-- 01g19p2b2eg3dmjfzj4qg7cywp: tech/go, tech/イベント参加
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('go', 'イベント参加')
  WHERE a.slug = '01g19p2b2eg3dmjfzj4qg7cywp';
-- 01g7kk2jy54b9d7ct876mexwkm: tech/neovim, tech/zig, tech/typescript, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('neovim', 'zig', 'typescript', '開発環境')
  WHERE a.slug = '01g7kk2jy54b9d7ct876mexwkm';
-- 01g83dwsgvzecbjq0vjfbfyma3: tech/zig, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('zig', '開発環境')
  WHERE a.slug = '01g83dwsgvzecbjq0vjfbfyma3';
-- 01gmj0rnrsx2rwsqyfj2m15ymb: misc/振り返り, tech/go, tech/neovim, tech/登壇
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'go', 'neovim', '登壇')
  WHERE a.slug = '01gmj0rnrsx2rwsqyfj2m15ymb';
-- 01h58x6g51p3p0dekcxdg39cm6: tech/イベント参加, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('イベント参加', 'キャリア')
  WHERE a.slug = '01h58x6g51p3p0dekcxdg39cm6';
-- 01h5eh62nbyxx8azf4nxsv350q: tech/イベント参加, misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('イベント参加', 'misc')
  WHERE a.slug = '01h5eh62nbyxx8azf4nxsv350q';
-- 20230717-lean-devops: tech/開発生産性, tech/devops, misc/読書
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('開発生産性', 'devops', '読書')
  WHERE a.slug = '20230717-lean-devops';
-- 20230718-tokyo-walking: misc/散歩
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('散歩')
  WHERE a.slug = '20230718-tokyo-walking';
-- 20230901-translate-cdk-developers-guide: tech/aws/cdk, misc/読書
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('cdk', '読書')
  WHERE a.slug = '20230901-translate-cdk-developers-guide';
-- 20230902-drive-memo: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '20230902-drive-memo';
-- 20230908-js-runtime: tech/javascript, tech/node.js, tech/deno
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('javascript', 'node.js', 'deno')
  WHERE a.slug = '20230908-js-runtime';
-- 20230915-wasm-night-11: tech/wasm, tech/イベント参加
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('wasm', 'イベント参加')
  WHERE a.slug = '20230915-wasm-night-11';
-- 20231014-rust-error-list: tech/rust, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('rust', '開発環境')
  WHERE a.slug = '20231014-rust-error-list';
-- 20231023-defes-matome: tech/deno, tech/javascript, tech/イベント参加
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('deno', 'javascript', 'イベント参加')
  WHERE a.slug = '20231023-defes-matome';
-- 20231118-vim-conf: tech/neovim, tech/denops, tech/イベント参加
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('neovim', 'denops', 'イベント参加')
  WHERE a.slug = '20231118-vim-conf';
-- 20231224-refleting-on-2023: misc/振り返り, tech/登壇, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', '登壇', 'キャリア')
  WHERE a.slug = '20231224-refleting-on-2023';
-- 20240205-snow-day-warn: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '20240205-snow-day-warn';
-- 20240206-learn-shutoko: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '20240206-learn-shutoko';
-- 20240211-ready-happy-wedding: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '20240211-ready-happy-wedding';
-- 20240212-youtube-best-practice: misc/youtube
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('youtube')
  WHERE a.slug = '20240212-youtube-best-practice';
-- 20240506-cloudinary-turai: tech/cloudinary, tech/aws/s3
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('cloudinary', 's3')
  WHERE a.slug = '20240506-cloudinary-turai';
-- 20240511-tskaigi-report: tech/typescript, tech/イベント参加
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('typescript', 'イベント参加')
  WHERE a.slug = '20240511-tskaigi-report';
-- 20240531-plum-wine: misc/料理
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('料理')
  WHERE a.slug = '20240531-plum-wine';
-- 20240722-insights-gained-from-public-speaking: misc/振り返り, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'キャリア')
  WHERE a.slug = '20240722-insights-gained-from-public-speaking';
-- 20240904-hiltukoshi: misc/引っ越し
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('引っ越し')
  WHERE a.slug = '20240904-hiltukoshi';
-- 20240914-hiltukoshi-2: misc/引っ越し
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('引っ越し')
  WHERE a.slug = '20240914-hiltukoshi-2';
-- 20240930-confirm-family-comms-in-writing: misc/コミュニケーション
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('コミュニケーション')
  WHERE a.slug = '20240930-confirm-family-comms-in-writing';
-- 20241115-ponponpain: misc/健康
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('健康')
  WHERE a.slug = '20241115-ponponpain';
-- 20241201-study-programming: tech/rust, tech/neovim, misc/キャリア, tech/nix
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('rust', 'neovim', 'キャリア', 'nix')
  WHERE a.slug = '20241201-study-programming';
-- 20241224-refleting-on-2024: misc/振り返り, tech/登壇, misc/キャリア, tech/raspberry-pi, tech/kubernetes
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', '登壇', 'キャリア', 'raspberry-pi', 'kubernetes')
  WHERE a.slug = '20241224-refleting-on-2024';
-- 20241224-tech-poem: tech/rust, tech/wasm, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('rust', 'wasm', 'キャリア')
  WHERE a.slug = '20241224-tech-poem';
-- 20250104-tech-poem: misc, tech/nix, tech/rust, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc', 'nix', 'rust', '開発環境')
  WHERE a.slug = '20250104-tech-poem';
-- 20250106-tech-poem: misc, tech/nix, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc', 'nix', '開発環境')
  WHERE a.slug = '20250106-tech-poem';
-- 20250107-tech-poem: misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('キャリア')
  WHERE a.slug = '20250107-tech-poem';
-- 20250108-poem: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '20250108-poem';
-- 20250109-tech-poem: misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('キャリア')
  WHERE a.slug = '20250109-tech-poem';
-- 20250114-poem: misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('キャリア')
  WHERE a.slug = '20250114-poem';
-- 20250115-async-runtime: tech/rust, tech/go, tech/node.js, tech/技術メモ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('rust', 'go', 'node.js', '技術メモ')
  WHERE a.slug = '20250115-async-runtime';
-- 20250116-poem: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '20250116-poem';
-- 20250116-poem2: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '20250116-poem2';
-- 20250124-poem: misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('キャリア')
  WHERE a.slug = '20250124-poem';
-- 2025022-tech-poem: tech/aws, tech/技術メモ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('aws', '技術メモ')
  WHERE a.slug = '2025022-tech-poem';
-- 20250302-poem: misc/振り返り, tech/rust, tech/mcp, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'rust', 'mcp', 'キャリア')
  WHERE a.slug = '20250302-poem';
-- 20250303-tech-poem: misc, tech/技術メモ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc', '技術メモ')
  WHERE a.slug = '20250303-tech-poem';
-- 20250411-poem: misc/振り返り, tech/mcp, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'mcp', 'キャリア')
  WHERE a.slug = '20250411-poem';
-- 20250615-plum-wine: misc/料理
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('料理')
  WHERE a.slug = '20250615-plum-wine';
-- 20250809-poem: misc/振り返り, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'キャリア')
  WHERE a.slug = '20250809-poem';
-- 20251101-poem: misc
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('misc')
  WHERE a.slug = '20251101-poem';
-- 20251224-reflecting-on-2025: misc/振り返り, tech/rust, tech/mcp, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'rust', 'mcp', 'キャリア')
  WHERE a.slug = '20251224-reflecting-on-2025';
-- 20260108-shuntaka-blog-rearchitecture: tech/rust, tech/aws/lambda, tech/next.js, tech/aws/cdk, tech/postgresql
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('rust', 'lambda', 'next.js', 'cdk', 'postgresql')
  WHERE a.slug = '20260108-shuntaka-blog-rearchitecture';
-- 20260117-poem: tech/開発環境, tech/rust, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('開発環境', 'rust', 'キャリア')
  WHERE a.slug = '20260117-poem';
-- 20260118-transfer-from-cloudflare: tech/cloudflare, tech/aws, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('cloudflare', 'aws', '開発環境')
  WHERE a.slug = '20260118-transfer-from-cloudflare';
-- 20260125-poem: misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('キャリア')
  WHERE a.slug = '20260125-poem';
-- 20260201-poem: misc/振り返り, tech/bun, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'bun', 'キャリア')
  WHERE a.slug = '20260201-poem';
-- 20260215-apple-developer: tech/開発環境, tech/macos, tech/tauri
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('開発環境', 'macos', 'tauri')
  WHERE a.slug = '20260215-apple-developer';
-- 20260301-poem: misc/振り返り, tech/tauri, misc/キャリア, tech/登壇
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'tauri', 'キャリア', '登壇')
  WHERE a.slug = '20260301-poem';
-- 20260315-poem: misc/キャリア, tech/技術メモ, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('キャリア', '技術メモ', '開発環境')
  WHERE a.slug = '20260315-poem';
-- 20260321-opencode-composer-2: tech/開発環境, tech/技術メモ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('開発環境', '技術メモ')
  WHERE a.slug = '20260321-opencode-composer-2';
-- 20260401-poem: misc/振り返り, tech/tauri, tech/rust, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'tauri', 'rust', 'キャリア')
  WHERE a.slug = '20260401-poem';
-- 20260501-poem: misc/振り返り, tech/tauri, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'tauri', 'キャリア')
  WHERE a.slug = '20260501-poem';
-- 20260601-poem: misc/振り返り, tech/github-actions, tech/tauri, misc/キャリア
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('振り返り', 'github-actions', 'tauri', 'キャリア')
  WHERE a.slug = '20260601-poem';
-- vim-conf-2024: tech/neovim, tech/イベント参加, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('neovim', 'イベント参加', '開発環境')
  WHERE a.slug = 'vim-conf-2024';
-- vim-conf-2025: tech/neovim, tech/イベント参加, tech/開発環境
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('neovim', 'イベント参加', '開発環境')
  WHERE a.slug = 'vim-conf-2025';
-- 20250614-2025fp-matsuri: tech/イベント参加, tech/関数型プログラミング
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('イベント参加', '関数型プログラミング')
  WHERE a.slug = '20250614-2025fp-matsuri';
-- 20260630-tidb-blog-query-tuning: tech/tidb, tech/技術メモ
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('tidb', '技術メモ')
  WHERE a.slug = '20260630-tidb-blog-query-tuning';

-- 検証用クエリ
-- SELECT t.name, COUNT(*) FROM tags t JOIN articles_tags at2 ON t.tag_id = at2.tag_id GROUP BY t.name ORDER BY COUNT(*) DESC;
-- SELECT COUNT(*) FROM articles a WHERE a.status = 'published' AND NOT EXISTS (SELECT 1 FROM articles_tags at2 WHERE at2.article_id = a.article_id);
