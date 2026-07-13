import exifr from 'exifr';

/** 撮影時刻の取得元。フォームでどこから補完したかを表示するのに使う */
export type CapturedAtSource = 'exif' | 'file' | 'now';

export interface CapturedAt {
  /** TZ なしの撮影ローカル日時 (YYYY-MM-DDTHH:mm:ss)。EXIF の壁時計をそのまま持つ */
  naive: string;
  source: CapturedAtSource;
}

export const capturedAtSourceLabels: Record<CapturedAtSource, string> = {
  exif: 'EXIF',
  file: 'ファイル更新日時',
  now: '現在時刻',
};

const EXIF_PICK = ['DateTimeOriginal', 'CreateDate'] as const;

// EXIF の日時は "YYYY:MM:DD HH:MM:SS" 形式の TZ なし文字列
const EXIF_DATETIME = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

const fromExifString = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const m = EXIF_DATETIME.exec(raw.trim());
  if (m === null) return null;
  const naive = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  // "0000:00:00 00:00:00" のような無効値を弾く
  return Number.isNaN(Date.parse(naive)) ? null : naive;
};

/** Date を端末ローカル TZ の壁時計文字列に整形する (フォールバック用) */
const toNaive = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * 選択された写真から撮影時刻をクライアント側で補完する。
 * EXIF (DateTimeOriginal → CreateDate) → ファイル更新日時 → 現在時刻の順にフォールバック。
 * 配信画像は canvas 再エンコードで EXIF が落ちるため、ここで読むのが唯一の機会。
 * EXIF は TZ 情報を持たないため Date に変換せず、壁時計の文字列のまま扱う
 * (reviveValues: false で exifr の Date 変換を止めて生文字列を受け取る)
 */
export const readCapturedAt = async (file: File): Promise<CapturedAt> => {
  try {
    const exif: unknown = await exifr.parse(file, { pick: [...EXIF_PICK], reviveValues: false });
    if (typeof exif === 'object' && exif !== null) {
      for (const key of EXIF_PICK) {
        const naive = fromExifString((exif as Record<string, unknown>)[key]);
        if (naive !== null) return { naive, source: 'exif' };
      }
    }
  } catch {
    // EXIF が読めない形式 (PNG のスクリーンショット等) はフォールバックへ
  }
  if (Number.isFinite(file.lastModified) && file.lastModified > 0) {
    return { naive: toNaive(new Date(file.lastModified)), source: 'file' };
  }
  return { naive: toNaive(new Date()), source: 'now' };
};
