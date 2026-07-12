type Props = {
  width?: number;
  height?: number;
  className?: string;
};

// SVG 本体は public/hashi-bow.svg に置き <img> で参照する。
// インライン SVG に戻すとエラーバウンダリ (error.tsx) 経由で
// 全ルートのクライアント JS に約 22 KiB のパスデータが同梱される
export function HashiBow({ width = 185, height = 212, className }: Props) {
  return (
    <img src="/hashi-bow.svg" width={width} height={height} className={className} alt="hashi" />
  );
}
