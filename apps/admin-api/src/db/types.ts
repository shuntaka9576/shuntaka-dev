import type { ColumnType } from 'kysely';

export type Fastener = 'clip' | 'tape';
export type FastenerColor = 'pink' | 'blue' | 'yellow' | 'green';
export type MomentStatus = 'published' | 'draft';

// dsl-tidb/schema/07_moments.sql の手書き型
export interface MomentsTable {
  moment_id: string;
  user_id: string;
  text: string;
  image_key: string;
  fastener: Fastener;
  fastener_color: FastenerColor | null;
  status: MomentStatus;
  // TZ なしの撮影ローカル日時。書き込みは "YYYY-MM-DDTHH:mm:ss" 文字列を無変換で渡す
  // (mysql2 は timezone: 'Z' のため、読み取り Date の UTC フィールド = 壁時計になる)
  captured_at: ColumnType<Date, string, string>;
  published_at: Date | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

// dsl-tidb/schema/08_admin_sessions.sql の手書き型
export interface AdminSessionsTable {
  sid: string;
  user_id: string;
  access_token: string;
  id_token: string;
  refresh_token: string;
  expires_at: Date;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

// 既存テーブル (dsl-tidb/schema/02_users.sql)。認証ユーザーの解決に参照のみ行う
export interface UsersTable {
  user_id: string;
  name: string;
  email: string;
  github_installation_id: number | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

// dsl-tidb/schema/10_labs.sql の手書き型。blog-api の webhook 同期が書き込み、
// admin-api は読み取りのみ行う
export interface LabsTable {
  lab_id: string;
  user_id: string;
  slug: string;
  title: string;
  summary: string | null;
  // TINYINT(1)。mysql2 は number で返す
  published: number;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

// dsl-tidb/schema/11_lab_chapters.sql の手書き型
export interface LabChaptersTable {
  chapter_id: string;
  lab_id: string;
  slug: string;
  title: string;
  position: number;
  content: string;
  content_html: string | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export type TodoPeriod = 'morning' | 'bedtime';
export type MealType = 'breakfast' | 'lunch' | 'dinner';
export type TodoQuickCategory = 'task' | 'blog_idea';

export interface TodoSettingsTable {
  user_id: string;
  timezone: string;
  generation_time: string;
  source_markdown: string;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface TodoTemplateItemsTable {
  template_item_id: string;
  user_id: string;
  period: TodoPeriod;
  parent_template_item_id: string | null;
  title: string;
  position: number;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface TodoDailyItemsTable {
  daily_item_id: string;
  user_id: string;
  todo_date: string;
  source_template_id: string;
  parent_daily_item_id: string | null;
  period: TodoPeriod;
  title: string;
  position: number;
  completed_at: Date | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface TodoMealsTable {
  meal_id: string;
  user_id: string;
  meal_date: string;
  meal_type: MealType;
  content: string;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface TodoShoppingItemsTable {
  shopping_item_id: string;
  user_id: string;
  name: string;
  normalized_name: string;
  quantity: string | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface TodoQuickItemsTable {
  quick_item_id: string;
  user_id: string;
  category: TodoQuickCategory;
  title: string;
  completed_at: Date | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface Database {
  moments: MomentsTable;
  admin_sessions: AdminSessionsTable;
  users: UsersTable;
  labs: LabsTable;
  lab_chapters: LabChaptersTable;
  todo_settings: TodoSettingsTable;
  todo_template_items: TodoTemplateItemsTable;
  todo_daily_items: TodoDailyItemsTable;
  todo_meals: TodoMealsTable;
  todo_shopping_items: TodoShoppingItemsTable;
  todo_quick_items: TodoQuickItemsTable;
}
