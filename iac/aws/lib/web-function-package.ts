import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '../../..');

// zip の作り方 (このファイル) を変えたら asset を作り直させるため、各 asset のハッシュに含める
const packagingHash = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');

// Web Functions の zip は CDK に作らせない。CDK の zip は実行権限と更新日時を残さないため
// (Rust のバイナリが起動できない / Next.js の事前生成ページが常に期限切れ扱いになる)。
// local bundling だけを使い、Docker のイメージは CDK の型を満たすためだけに指定する
const unusedBundlingImage = cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:24');

const zipDirectory = (dir: string, outputDir: string): void => {
  // zip はタイムゾーンを持たない現地時刻で日時を記録するので、Lambda と同じ UTC で作る。
  // -y でシンボリックリンクをリンクのまま入れる (bun の node_modules はリンクで組まれており、
  // 実体化すると Node.js の realpath による解決が崩れて依存が見つからなくなる)
  execSync(`zip -qry ${JSON.stringify(path.join(outputDir, 'app.zip'))} .`, {
    cwd: dir,
    env: { ...process.env, TZ: 'UTC' },
  });
};

/**
 * blog-api (Rust / Axum) を Web Function 用に包む。
 *
 * Web Functions のランタイムは Node.js のみのため、index.mjs から server バイナリを
 * 子プロセスで起動し、HTTP は Rust が AWS_LAMBDA_HTTP_ENDPOINT で直接待ち受ける。
 * 実行環境の glibc に依存しないよう aarch64 の musl で静的リンクする (cargo-zigbuild が必要)。
 */
export const blogApiWebFunctionCode = (): s3deploy.ISource => {
  const target = 'aarch64-unknown-linux-musl';
  // Event Function の Docker イメージと同じ .dockerignore で Rust のソースだけに絞ってハッシュを取る
  const sourceHash = cdk.FileSystem.fingerprint(repoRoot, {
    ignoreMode: cdk.IgnoreMode.DOCKER,
    exclude: fs
      .readFileSync(path.join(repoRoot, '.dockerignore'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#')),
  });
  return s3deploy.Source.asset(repoRoot, {
    assetHashType: cdk.AssetHashType.CUSTOM,
    assetHash: createHash('sha256').update(sourceHash).update(packagingHash).digest('hex'),
    bundling: {
      image: unusedBundlingImage,
      outputType: cdk.BundlingOutput.ARCHIVED,
      local: {
        tryBundle(outputDir) {
          execSync(`cargo zigbuild --release --target ${target} --bin server`, {
            cwd: repoRoot,
            stdio: 'inherit',
          });
          const packageDir = path.join(repoRoot, 'target/web-function/blog-api');
          fs.rmSync(packageDir, { recursive: true, force: true });
          fs.mkdirSync(packageDir, { recursive: true });
          const server = path.join(packageDir, 'server');
          fs.copyFileSync(path.join(repoRoot, `target/${target}/release/server`), server);
          fs.chmodSync(server, 0o755);
          fs.copyFileSync(
            path.join(repoRoot, 'apps/blog-api/web-function/index.mjs'),
            path.join(packageDir, 'index.mjs'),
          );
          zipDirectory(packageDir, outputDir);
          return true;
        },
      },
    },
  });
};

/**
 * apps/web (Next.js) の standalone 出力を Web Function 用に包む。
 *
 * buildEnv は next build に渡す環境変数 (NEXT_PUBLIC_* はビルド時に焼き込まれる)。
 * next build はビルドごとに build ID が変わるため、出力ではなくソースと buildEnv で
 * ハッシュを取る。そうしないと synth のたびに revision が作り直される
 */
export const webWebFunctionCode = (buildEnv: Record<string, string>): s3deploy.ISource => {
  const webDir = path.join(repoRoot, 'apps/web');
  const sourceHash = cdk.FileSystem.fingerprint(webDir, {
    exclude: [
      'node_modules',
      '.next',
      '.turbo',
      '.vercel',
      '.env*',
      'storybook-static',
      'next-env.d.ts',
      '*.tsbuildinfo',
    ],
  });
  const assetHash = createHash('sha256')
    .update(sourceHash)
    .update(fs.readFileSync(path.join(repoRoot, 'bun.lock')))
    .update(JSON.stringify(buildEnv))
    .update(packagingHash)
    .digest('hex');

  return s3deploy.Source.asset(webDir, {
    assetHashType: cdk.AssetHashType.CUSTOM,
    assetHash,
    bundling: {
      image: unusedBundlingImage,
      outputType: cdk.BundlingOutput.ARCHIVED,
      local: {
        tryBundle(outputDir) {
          execSync('bun run build', {
            cwd: webDir,
            stdio: 'inherit',
            env: { ...process.env, ...buildEnv, NEXT_TELEMETRY_DISABLED: '1' },
          });
          const packageDir = path.join(webDir, '.next/web-function');
          fs.rmSync(packageDir, { recursive: true, force: true });
          // Next.js は事前生成ページの描画時刻をファイルの mtime から取るため日時を残してコピーする。
          // standalone のシンボリックリンクは相対パスのまま残す (既定だとコピー元の絶対パスに書き換わる)
          const copy = (from: string, to: string, filter?: (source: string) => boolean) =>
            fs.cpSync(from, to, {
              recursive: true,
              preserveTimestamps: true,
              verbatimSymlinks: true,
              filter,
            });
          // outputFileTracingRoot をリポジトリのルートにしているので、server.js は apps/web/ 配下に出る。
          // images.unoptimized のため sharp は使わない。macOS でビルドすると Linux で動かない darwin 用の
          // バイナリ (@img/sharp-darwin-arm64 など) が standalone に入るだけなので外す。bun の node_modules は
          // .bun/ 配下 (sharp@x.y.z / @img+sharp-*) にあり outputFileTracingExcludes では外せなかった
          copy(
            path.join(webDir, '.next/standalone'),
            packageDir,
            (source) => !/\/node_modules\/(?:\.bun\/)?(?:sharp|@img)(?:[@+/]|$)/.test(source),
          );
          // standalone の server.js は public と .next/static を自分では持たないのでコピーする
          copy(path.join(webDir, '.next/static'), path.join(packageDir, 'apps/web/.next/static'));
          copy(path.join(webDir, 'public'), path.join(packageDir, 'apps/web/public'));
          copy(path.join(webDir, 'web-function/index.mjs'), path.join(packageDir, 'index.mjs'));
          zipDirectory(packageDir, outputDir);
          return true;
        },
      },
    },
  });
};

/**
 * apps/mcp-server (Hono の MCP サーバー) を Web Function 用に包む。
 *
 * esbuild で依存ごと 1 ファイル (dist/index.mjs) にまとめ、それをそのまま zip のルートの index.mjs にする
 */
export const mcpServerWebFunctionCode = (): s3deploy.ISource => {
  const appDir = path.join(repoRoot, 'apps/mcp-server');
  const assetHash = createHash('sha256')
    .update(
      cdk.FileSystem.fingerprint(appDir, {
        exclude: ['node_modules', 'dist', '.turbo', '*.tsbuildinfo', '*.test.ts'],
      }),
    )
    .update(fs.readFileSync(path.join(repoRoot, 'bun.lock')))
    .update(packagingHash)
    .digest('hex');

  return s3deploy.Source.asset(appDir, {
    assetHashType: cdk.AssetHashType.CUSTOM,
    assetHash,
    bundling: {
      image: unusedBundlingImage,
      outputType: cdk.BundlingOutput.ARCHIVED,
      local: {
        tryBundle(outputDir) {
          execSync('bun run build', { cwd: appDir, stdio: 'inherit' });
          const packageDir = path.join(appDir, 'dist/web-function');
          fs.rmSync(packageDir, { recursive: true, force: true });
          fs.mkdirSync(packageDir, { recursive: true });
          fs.copyFileSync(path.join(appDir, 'dist/index.mjs'), path.join(packageDir, 'index.mjs'));
          zipDirectory(packageDir, outputDir);
          return true;
        },
      },
    },
  });
};
