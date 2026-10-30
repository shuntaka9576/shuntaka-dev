import {
  DeleteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { TokenStorage } from 'fastmcp/auth';

// OAuthProxy の状態 (DCR で登録したクライアント、認可トランザクション、認可コード、トークンの対応) を
// DynamoDB に置く。実行環境が複数あっても、どの環境に届いたリクエストでも同じ状態を見られる。
// 値は OAuthProxy が EncryptedTokenStorage で暗号化した文字列が渡ってくる。
//
// テーブルはパーティションキー `pk` のみ。DynamoDB の TTL は期限後すぐには消さない (最大 48 時間ほど残る) ため、
// 読み出し時にも `ttl` を見て期限切れを無いものとして扱う
export class DynamoDbTokenStorage implements TokenStorage {
  constructor(
    private readonly client: Pick<DynamoDBClient, 'send'>,
    private readonly tableName: string,
    private readonly now: () => number = Date.now,
  ) {}

  async save(key: string, value: unknown, ttl?: number): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          pk: { S: key },
          value: { S: JSON.stringify(value) },
          ...(ttl !== undefined && {
            ttl: { N: String(Math.floor(this.now() / 1000) + Math.ceil(ttl)) },
          }),
        },
      }),
    );
  }

  async get(key: string): Promise<unknown> {
    const { Item } = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: key } },
        // 直前に別の実行環境が書いた認可コードやトランザクションを読むため
        ConsistentRead: true,
      }),
    );
    return this.decode(Item);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({ TableName: this.tableName, Key: { pk: { S: key } } }),
    );
  }

  // 認可コードとリフレッシュトークンを 1 回しか使えないようにするため、読み出しと削除を 1 回の DeleteItem で行う
  async take(key: string): Promise<unknown> {
    const { Attributes } = await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: key } },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return this.decode(Attributes);
  }

  // 期限切れの項目は DynamoDB の TTL が消す
  async cleanup(): Promise<void> {}

  private decode(item: Record<string, { S?: string; N?: string }> | undefined): unknown {
    const value = item?.value?.S;
    if (value === undefined) {
      return null;
    }
    const expiresAt = item?.ttl?.N;
    if (expiresAt !== undefined && Number(expiresAt) * 1000 <= this.now()) {
      return null;
    }
    return JSON.parse(value);
  }
}
