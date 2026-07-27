local M = {}

M.defaults = {
  root_dir = nil, -- 未指定なら resolve_root_dir で自動検出
  port = 0, -- 0 = エフェメラルポート
  debounce_ms = 150, -- TextChanged 系のデバウンス
  open_browser = true, -- 起動時にブラウザを自動で開く
  bun_cmd = 'bun',
  articles_dir = nil, -- 記事一覧の対象。未指定ならプレビュー中ファイルと同じディレクトリ
}

-- このファイル (lua/shuntaka-preview/config.lua) から 3 階層上 = プラグインルート
-- (tools/shuntaka-preview.nvim)。lazy.nvim の plugin.dir に依存しないため、
-- 手動の rtp 追加や packadd でも動く
function M.resolve_root_dir(opts)
  if opts.root_dir then
    return opts.root_dir
  end
  local source = debug.getinfo(1, 'S').source:sub(2)
  return vim.fn.fnamemodify(source, ':p:h:h:h')
end

return M
