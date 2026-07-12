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
  published_at: Date | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

// dsl-tidb/schema/08_admin_sessions.sql の手書き型
export interface AdminSessionsTable {
  sid: string;
  access_token: string;
  id_token: string;
  refresh_token: string;
  expires_at: Date;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface Database {
  moments: MomentsTable;
  admin_sessions: AdminSessionsTable;
}
