// DynamoDB Article (旧形式)
export interface DynamoArticle {
  articleId: string;
  title: string;
  content: string;
  type: 'tech' | 'note';
  userId: string;
  createAt: number; // Unix timestamp (ms)
  updateAt: number; // Unix timestamp (ms)
  publishAt?: number; // Unix timestamp (ms)
  typePublishAt?: string; // "type-timestamp" 形式
  thumbnail?: string;
  category?: string[];
  description?: string;
}

// DSQL Article (新形式)
export interface DsqlArticle {
  article_id: string; // UUID
  title: string;
  slug: string;
  user_id: string; // UUID
  content: string;
  thumbnail: string | null;
  description: string; // NOT NULL
  status: 'draft' | 'review' | 'scheduled' | 'published' | 'archived';
  type: 'tech' | 'note';
  published_at: string | null; // ISO8601
  created_at: string; // ISO8601
  updated_at: string; // ISO8601
}

// DSQL Role
export interface DsqlRole {
  role_id: string; // UUID
  name: string;
}

// DSQL User
export interface DsqlUser {
  user_id: string; // UUID
  name: string;
  email: string;
  role_id: string; // UUID
  created_at: string; // ISO8601
  updated_at: string; // ISO8601
}
