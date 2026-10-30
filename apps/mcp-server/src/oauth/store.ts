// 認可サーバーの状態 (DCR で登録したクライアント、認可トランザクション、認可コード、grant) の置き場所。
// どの値にも期限を付け、期限を過ぎたものは無いものとして扱う。値は JSON で保存する
export interface OAuthStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** 保存されている値が expected と同じときだけ value に置き換える。置き換えたら true */
  replace(key: string, expected: unknown, value: unknown, ttlSeconds: number): Promise<boolean>;
  /** 読み出しと削除を 1 回で行う。同じキーを同時に take しても値を受け取るのは 1 回だけ */
  take<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
}

/** ローカル実行 (src/dev.ts) 用。DynamoDB 実装と同じく JSON で保存し、読み出し時に期限を見る */
export class MemoryStore implements OAuthStore {
  private readonly items = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string): Promise<T | null> {
    return this.read<T>(key);
  }

  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.write(key, value, ttlSeconds);
  }

  async replace(
    key: string,
    expected: unknown,
    value: unknown,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (this.items.get(key)?.value !== JSON.stringify(expected)) {
      return false;
    }
    this.write(key, value, ttlSeconds);
    return true;
  }

  // 読み出しから削除までの間に await を挟まない。同時に take されても値を返すのは 1 回だけ
  async take<T>(key: string): Promise<T | null> {
    const value = this.read<T>(key);
    this.items.delete(key);
    return value;
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }

  private read<T>(key: string): T | null {
    const item = this.items.get(key);
    if (item === undefined || item.expiresAt <= this.now()) {
      return null;
    }
    return JSON.parse(item.value) as T;
  }

  private write(key: string, value: unknown, ttlSeconds: number) {
    this.items.set(key, {
      value: JSON.stringify(value),
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }
}
