import exifr from 'exifr';

/** 撮影時刻の取得元。フォームでどこから補完したかを表示するのに使う */
export type CapturedAtSource = 'exif' | 'file' | 'now';

export interface CapturedAt {
  /** ISO 8601 (offset 付き)。API へそのまま送る */
  iso: string;
  source: CapturedAtSource;
}

export const capturedAtSourceLabels: Record<CapturedAtSource, string> = {
  exif: 'EXIF',
  file: 'ファイル更新日時',
  now: '現在時刻',
};

// EXIF の DateTimeOriginal はタイムゾーンを持たないため、exifr は端末のローカル
// タイムゾーンの Date として返す。国内撮影 + JST 端末なら実撮影時刻と一致する
const EXIF_PICK = ['DateTimeOriginal', 'CreateDate'] as const;

/**
 * 選択された写真から撮影時刻をクライアント側で補完する。
 * EXIF (DateTimeOriginal → CreateDate) → ファイル更新日時 → 現在時刻の順にフォールバック。
 * 配信画像は canvas 再エンコードで EXIF が落ちるため、ここで読むのが唯一の機会
 */
export const readCapturedAt = async (file: File): Promise<CapturedAt> => {
  try {
    const exif: unknown = await exifr.parse(file, { pick: [...EXIF_PICK] });
    if (typeof exif === 'object' && exif !== null) {
      for (const key of EXIF_PICK) {
        const value = (exif as Record<string, unknown>)[key];
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
          return { iso: value.toISOString(), source: 'exif' };
        }
      }
    }
  } catch {
    // EXIF が読めない形式 (PNG のスクリーンショット等) はフォールバックへ
  }
  if (Number.isFinite(file.lastModified) && file.lastModified > 0) {
    return { iso: new Date(file.lastModified).toISOString(), source: 'file' };
  }
  return { iso: new Date().toISOString(), source: 'now' };
};
