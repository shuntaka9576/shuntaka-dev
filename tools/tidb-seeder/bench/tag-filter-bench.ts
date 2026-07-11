/**
 * タグ絞り込み・ファセット集計のベースライン計測スクリプト。
 *
 * tidb-seeder で投入した blog_test に対して、サーバーサイドタグ絞り込み
 * （docs/source/98_tasks/2026-07-05-server-side-tag-filter/index.md）で想定している
 * クエリ群を実行し、実行時間を出力する。
 *
 * 現行本番形（相関 GROUP_CONCAT でタグを1カラムに集約）は 50万件でページング
 * に耐えないことが判明したため、「一覧はタグなしで取得 → ページ内の 10 記事分
 * だけタグを別クエリで取得」する2クエリ方式（proposed）を併せて計測する。
 *
 * 使い方:
 *   bun bench/tag-filter-bench.ts --host 127.0.0.1 --port 4100 --database blog_test
 */
import mysql from 'mysql2/promise';

interface Args {
  host: string;
  port: number;
  database: string;
  runs: number;
}

function parseArgs(): Args {
  const args: Args = { host: '127.0.0.1', port: 4100, database: 'blog_test', runs: 5 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) break;
    if (key === '--host') args.host = value;
    if (key === '--port') args.port = Number.parseInt(value, 10);
    if (key === '--database') args.database = value;
    if (key === '--runs') args.runs = Number.parseInt(value, 10);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs();
  let conn = await connect(args);

  async function connect(a: Args): Promise<mysql.Connection> {
    return mysql.createConnection({
      host: a.host,
      port: a.port,
      user: 'root',
      database: a.database,
    });
  }

  const one = async (sql: string): Promise<Record<string, unknown>[]> => {
    const [rows] = await conn.query(sql);
    return rows as Record<string, unknown>[];
  };

  // AND 計測が root 違い（tech × misc）で 0 件マッチにならないよう、
  // hot / mid / rare は tech root 配下のタグに限定して選ぶ
  const dist = await one(
    `WITH RECURSIVE tag_roots AS (
       SELECT tag_id, name AS root_name FROM tags WHERE parent_tag_id IS NULL
       UNION ALL
       SELECT t.tag_id, tr.root_name FROM tags t JOIN tag_roots tr ON t.parent_tag_id = tr.tag_id
     )
     SELECT at2.tag_id, t.name, COUNT(*) AS cnt
     FROM articles_tags at2
     JOIN tags t ON t.tag_id = at2.tag_id
     JOIN tag_roots r ON r.tag_id = at2.tag_id
     WHERE r.root_name = 'tech'
     GROUP BY at2.tag_id, t.name ORDER BY cnt DESC`,
  );
  const hot = dist[0];
  const mid = dist[Math.floor(dist.length / 2)];
  const rare = dist[dist.length - 1];
  const parentRow = (
    await one(
      `WITH RECURSIVE tag_roots AS (
         SELECT tag_id, name AS root_name FROM tags WHERE parent_tag_id IS NULL
         UNION ALL
         SELECT t.tag_id, tr.root_name FROM tags t JOIN tag_roots tr ON t.parent_tag_id = tr.tag_id
       )
       SELECT p.tag_id, p.name, COUNT(*) AS child_count
       FROM tags p JOIN tags c ON c.parent_tag_id = p.tag_id
       JOIN tag_roots r ON r.tag_id = p.tag_id
       WHERE p.parent_tag_id IS NOT NULL AND r.root_name = 'tech'
       GROUP BY p.tag_id, p.name ORDER BY child_count DESC LIMIT 1`,
    )
  )[0];
  const userRow = (await one(`SELECT user_id, name FROM users LIMIT 1`))[0];
  if (!hot || !mid || !rare || !parentRow || !userRow) throw new Error('seed data not found');

  const userName = String(userRow.name);
  console.log(`# tag-filter-bench`);
  console.log(`# user=${userName}`);
  console.log(
    `# hot=${String(hot.name)} (${String(hot.cnt)}) mid=${String(mid.name)} (${String(mid.cnt)}) rare=${String(rare.name)} (${String(rare.cnt)})`,
  );
  console.log(
    `# parent(with children)=${String(parentRow.name)} (children: ${String(parentRow.child_count)})`,
  );

  const tagPathsCte = `tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
  )`;
  const descendantsCte = (tagIds: string[]) => `tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (${tagIds.map((t) => `'${t}'`).join(',')})
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
  )`;
  const existsFor = (tagId: string) => `EXISTS (
    SELECT 1 FROM articles_tags at2 JOIN tag_descendants td
      ON at2.tag_id = td.tag_id AND td.root_tag_id = '${tagId}'
    WHERE at2.article_id = a.article_id)`;
  const baseWhere = `a.user_id = (SELECT user_id FROM users WHERE name = '${userName}')
    AND a.status = 'published' AND a.type = 'tech'`;
  // 現行形: 相関サブクエリ GROUP_CONCAT でタグ集約（50万件で破綻することの記録用）
  const currentShapeSelect = `a.article_id, a.title, a.slug,
    (SELECT GROUP_CONCAT(tp.path SEPARATOR ',') FROM articles_tags at3 JOIN tag_paths tp ON at3.tag_id = tp.tag_id
     WHERE at3.article_id = a.article_id) AS tag_names,
    a.published_at`;
  // 提案形: 一覧はタグなし、ページ内 ID に対して別クエリでタグ取得
  const proposedSelect = `a.article_id, a.title, a.slug, a.thumbnail, a.description, a.type, a.published_at, a.created_at, a.updated_at`;
  const orderLimit = (offset: number) =>
    `ORDER BY a.published_at DESC, a.article_id DESC LIMIT 10 OFFSET ${offset}`;

  const filtersFor = (filterTagIds: string[], mode: 'and' | 'or') =>
    mode === 'and'
      ? filterTagIds.map((t) => existsFor(t)).join('\n  AND ')
      : `EXISTS (SELECT 1 FROM articles_tags at2 JOIN tag_descendants td ON at2.tag_id = td.tag_id
           WHERE at2.article_id = a.article_id)`;

  const listQuery = (filterTagIds: string[], mode: 'and' | 'or', offset = 0) =>
    `WITH RECURSIVE ${descendantsCte(filterTagIds)}
     SELECT ${proposedSelect} FROM articles a
     WHERE ${baseWhere} AND ${filtersFor(filterTagIds, mode)} ${orderLimit(offset)}`;
  const countQuery = (filterTagIds: string[], mode: 'and' | 'or') =>
    `WITH RECURSIVE ${descendantsCte(filterTagIds)}
     SELECT COUNT(*) AS cnt FROM articles a WHERE ${baseWhere} AND ${filtersFor(filterTagIds, mode)}`;
  const ancestorsCte = `tag_ancestors AS (
    SELECT tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    SELECT ta.tag_id, t.parent_tag_id FROM tag_ancestors ta JOIN tags t ON t.tag_id = ta.anc_tag_id
    WHERE t.parent_tag_id IS NOT NULL
  )`;
  const facetsQuery = (filterTagIds: string[]) => {
    const withClause =
      filterTagIds.length > 0
        ? `WITH RECURSIVE ${descendantsCte(filterTagIds)}, ${ancestorsCte}`
        : `WITH RECURSIVE ${ancestorsCte}`;
    const filters =
      filterTagIds.length > 0
        ? `AND ${filterTagIds.map((t) => existsFor(t)).join('\n  AND ')}`
        : '';
    return `${withClause}
      SELECT anc.anc_tag_id, COUNT(DISTINCT at2.article_id) AS cnt
      FROM articles a
      JOIN articles_tags at2 ON at2.article_id = a.article_id
      JOIN tag_ancestors anc ON anc.tag_id = at2.tag_id
      WHERE ${baseWhere} ${filters}
      GROUP BY anc.anc_tag_id ORDER BY cnt DESC`;
  };

  // 提案形の2クエリ目: ページ内の記事 ID に対するタグ取得
  const pageIds = (
    await one(`SELECT article_id FROM articles a WHERE ${baseWhere} ${orderLimit(0)}`)
  ).map((r) => `'${String(r.article_id)}'`);
  const tagsForIdsQuery = `WITH RECURSIVE ${tagPathsCte}
    SELECT at2.article_id, GROUP_CONCAT(tp.path SEPARATOR ',') AS tag_names
    FROM articles_tags at2 JOIN tag_paths tp ON at2.tag_id = tp.tag_id
    WHERE at2.article_id IN (${pageIds.join(',')})
    GROUP BY at2.article_id`;

  const hotId = String(hot.tag_id);
  const midId = String(mid.tag_id);
  const rareId = String(rare.tag_id);
  const parentId = String(parentRow.tag_id);

  const targets: { name: string; sql: string }[] = [
    {
      name: 'current shape: list page1 w/ GROUP_CONCAT subquery (no filter)',
      sql: `WITH RECURSIVE ${tagPathsCte} SELECT ${currentShapeSelect} FROM articles a WHERE ${baseWhere} ${orderLimit(0)}`,
    },
    {
      name: 'proposed: list page1 (no filter, no tags col)',
      sql: `SELECT ${proposedSelect} FROM articles a WHERE ${baseWhere} ${orderLimit(0)}`,
    },
    {
      name: 'proposed: list deep offset page1000 (no filter)',
      sql: `SELECT ${proposedSelect} FROM articles a WHERE ${baseWhere} ${orderLimit(9990)}`,
    },
    { name: 'proposed: tags for page ids (10 ids)', sql: tagsForIdsQuery },
    {
      name: 'baseline: count (no filter)',
      sql: `SELECT COUNT(*) AS cnt FROM articles a WHERE ${baseWhere}`,
    },
    { name: 'filter: single hot leaf, list page1', sql: listQuery([hotId], 'and') },
    { name: 'filter: single hot leaf, count', sql: countQuery([hotId], 'and') },
    { name: 'filter: single rare leaf, list page1', sql: listQuery([rareId], 'and') },
    { name: 'filter: parent tag (descendants), list page1', sql: listQuery([parentId], 'and') },
    { name: 'filter: parent tag (descendants), count', sql: countQuery([parentId], 'and') },
    { name: 'filter: hot AND mid, list page1', sql: listQuery([hotId, midId], 'and') },
    { name: 'filter: hot AND mid, count', sql: countQuery([hotId, midId], 'and') },
    { name: 'filter: hot OR mid, list page1', sql: listQuery([hotId, midId], 'or') },
    { name: 'filter: hot OR mid, count', sql: countQuery([hotId, midId], 'or') },
    { name: 'facets: no selection (type all)', sql: facetsQuery([]) },
    {
      // blog-api adapter のフィルタなし分岐と同形（tag_article_counts 前計算。要バックフィル）
      name: 'facets: no selection via tag_article_counts (precomputed)',
      sql: `WITH RECURSIVE ${tagPathsCte}
        SELECT tp.path, tac.article_count AS cnt
        FROM tag_article_counts tac
        JOIN tag_paths tp ON tp.tag_id = tac.tag_id
        WHERE tac.user_id = (SELECT user_id FROM users WHERE name = '${userName}')
          AND tac.\`type\` = 'tech' AND tac.article_count > 0
        ORDER BY tac.article_count DESC, tp.path ASC`,
    },
    { name: 'facets: selected hot', sql: facetsQuery([hotId]) },
    { name: 'facets: selected hot AND mid', sql: facetsQuery([hotId, midId]) },
  ];

  for (const target of targets) {
    try {
      await one(target.sql); // warmup
      const times: number[] = [];
      let rowCount = 0;
      for (let i = 0; i < args.runs; i++) {
        const t0 = performance.now();
        const rows = await one(target.sql);
        times.push(performance.now() - t0);
        rowCount = rows.length;
      }
      times.sort((x, y) => x - y);
      const avg = times.reduce((s, t) => s + t, 0) / times.length;
      console.log(
        `\n== ${target.name}\n   rows=${rowCount} runs=${args.runs} min=${(times[0] as number).toFixed(1)}ms avg=${avg.toFixed(1)}ms max=${(times[times.length - 1] as number).toFixed(1)}ms`,
      );
    } catch (e) {
      console.log(`\n== ${target.name}\n   FAILED: ${e instanceof Error ? e.message : String(e)}`);
      // 接続断（サーバー OOM 等）は張り直して次のターゲットへ
      try {
        await conn.end();
      } catch {}
      await new Promise((r) => setTimeout(r, 3000));
      try {
        conn = await connect(args);
      } catch {
        console.log('   reconnect failed, aborting');
        break;
      }
    }
  }

  await conn.end();
}

await main();
