import {
  type AttributeValue,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { OAuthStore } from './store.js';

// 認可サーバーの状態を DynamoDB に置く。実行環境が複数あっても、どの環境に届いたリクエストでも同じ状態を見られる。
//
// テーブルはパーティションキー `pk` のみで、値は JSON 文字列の `value`、期限は epoch 秒の `ttl`。
// DynamoDB の TTL は期限後すぐには消さない (最大 48 時間ほど残る) ため、読み出し時にも `ttl` を見て
// 期限切れを無いものとして扱う
export class DynamoDbStore implements OAuthStore {
  constructor(
    private readonly client: Pick<DynamoDBClient, 'send'>,
    private readonly tableName: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const { Item } = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: key } },
        // 直前に別の実行環境が書いたトランザクションや grant を読むため
        ConsistentRead: true,
      }),
    );
    return this.decode<T>(Item);
  }

  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.send(
      new PutItemCommand({ TableName: this.tableName, Item: this.encode(key, value, ttlSeconds) }),
    );
  }

  // grant のリフレッシュトークンの入れ替えに使う。同じリフレッシュトークンで同時に更新されても、入れ替えられるのは 1 回だけ
  async replace(
    key: string,
    expected: unknown,
    value: unknown,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: this.encode(key, value, ttlSeconds),
          ConditionExpression: '#value = :expected',
          ExpressionAttributeNames: { '#value': 'value' },
          ExpressionAttributeValues: { ':expected': { S: JSON.stringify(expected) } },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }

  // 認可コードを 1 回しか使えないようにするため、読み出しと削除を 1 回の DeleteItem で行う
  async take<T>(key: string): Promise<T | null> {
    const { Attributes } = await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: key } },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return this.decode<T>(Attributes);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({ TableName: this.tableName, Key: { pk: { S: key } } }),
    );
  }

  private encode(key: string, value: unknown, ttlSeconds: number): Record<string, AttributeValue> {
    return {
      pk: { S: key },
      value: { S: JSON.stringify(value) },
      // 切り上げて、期限より早く消えることがないようにする
      ttl: { N: String(Math.ceil((this.now() + ttlSeconds * 1000) / 1000)) },
    };
  }

  private decode<T>(item: Record<string, AttributeValue> | undefined): T | null {
    const value = item?.value?.S;
    const expiresAt = item?.ttl?.N;
    if (value === undefined || expiresAt === undefined || Number(expiresAt) * 1000 <= this.now()) {
      return null;
    }
    return JSON.parse(value) as T;
  }
}
