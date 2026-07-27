local buffer = require('shuntaka-preview.buffer')
local config = require('shuntaka-preview.config')
local job = require('shuntaka-preview.job')

local M = {}

-- グローバルに 1 セッション (1 サーバープロセス)。attach 先のバッファは
-- 記事一覧クリック (open) で付け替わる。別バッファで :ShuntakaPreview したら
-- 既存セッションを止めてから起動し直す
local state = { job_id = nil, port = nil, bufnr = nil, buf_handle = nil, opts = nil }

function M.setup(user_opts)
  state.opts = vim.tbl_deep_extend('force', config.defaults, user_opts or {})
  vim.api.nvim_create_user_command('ShuntakaPreview', M.start, {})
  vim.api.nvim_create_user_command('ShuntakaPreviewStop', M.stop, {})
end

-- プレビュー追従対象にできるバッファか（markdown の実ファイルのみ）
local function is_previewable(bufnr)
  if vim.bo[bufnr].buftype ~= '' then
    return false
  end
  local name = vim.api.nvim_buf_get_name(bufnr)
  return vim.bo[bufnr].filetype == 'markdown' or name:match('%.md$') ~= nil
end

-- attach 先バッファを付け替え、初回分のバッファ内容とカーソル位置を送る
local function attach_buffer(bufnr)
  if state.buf_handle then
    buffer.detach(state.buf_handle)
  end
  state.bufnr = bufnr
  state.buf_handle = buffer.attach(bufnr, {
    debounce_ms = state.opts.debounce_ms,
    on_update = M.send_buffer,
    on_cursor = M.send_cursor,
  })

  local lifecycle = vim.api.nvim_create_augroup('ShuntakaPreviewLifecycle', { clear = true })
  vim.api.nvim_create_autocmd('BufUnload', { group = lifecycle, buffer = bufnr, callback = M.stop })
  vim.api.nvim_create_autocmd('VimLeavePre', { group = lifecycle, callback = M.stop })
  -- 別の markdown バッファに移ったらプレビューも追従する
  vim.api.nvim_create_autocmd('BufEnter', {
    group = lifecycle,
    callback = function(ev)
      if state.job_id and ev.buf ~= state.bufnr and is_previewable(ev.buf) then
        attach_buffer(ev.buf)
      end
    end,
  })

  M.send_buffer()
  M.send_cursor()
end

function M.start()
  state.opts = state.opts or config.defaults
  local bufnr = vim.api.nvim_get_current_buf()
  if vim.bo[bufnr].filetype ~= 'markdown' then
    vim.notify('shuntaka-preview: markdown バッファで実行すること', vim.log.levels.ERROR)
    return
  end
  if state.job_id then
    M.stop()
  end

  local root_dir = config.resolve_root_dir(state.opts)
  state.job_id = job.start(root_dir, state.opts, {
    on_ready = function(port)
      state.port = port
      local url = 'http://127.0.0.1:' .. port .. '/'
      if state.opts.open_browser then
        local opener = vim.fn.has('mac') == 1 and 'open' or 'xdg-open'
        vim.fn.jobstart({ opener, url }, { detach = true })
      end
      vim.notify('shuntaka-preview: ' .. url)
    end,
    on_open = function(path)
      -- 記事一覧クリック: 対象ファイルを :edit する（attach は BufEnter 追従に任せる）
      vim.schedule(function()
        if not state.job_id then
          return
        end
        local current = state.bufnr and vim.api.nvim_buf_get_name(state.bufnr) or nil
        if current == path then
          return
        end
        vim.cmd.edit(vim.fn.fnameescape(path))
      end)
    end,
    on_debug = function(line)
      vim.notify('shuntaka-preview[server]: ' .. line, vim.log.levels.DEBUG)
    end,
    on_exit = function(code)
      if code ~= 0 and state.job_id then
        vim.notify('shuntaka-preview: サーバーが終了した (code=' .. code .. ')', vim.log.levels.WARN)
      end
      state.job_id, state.port = nil, nil
    end,
  })
  if state.job_id <= 0 then
    vim.notify('shuntaka-preview: bun を起動できない (' .. state.opts.bun_cmd .. ')', vim.log.levels.ERROR)
    state.job_id = nil
    return
  end

  attach_buffer(bufnr)
end

function M.send_buffer()
  if not state.job_id or not vim.api.nvim_buf_is_valid(state.bufnr) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(state.bufnr, 0, -1, false)
  job.send(state.job_id, {
    type = 'update',
    bufnr = state.bufnr,
    text = table.concat(lines, '\n'),
    path = vim.api.nvim_buf_get_name(state.bufnr),
  })
end

function M.send_cursor()
  if not state.job_id or not vim.api.nvim_buf_is_valid(state.bufnr) then
    return
  end
  -- 対象バッファを表示していないウィンドウのカーソルは同期しない
  if vim.api.nvim_get_current_buf() ~= state.bufnr then
    return
  end
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local line_count = vim.api.nvim_buf_line_count(state.bufnr)
  job.send(state.job_id, { type = 'cursor', bufnr = state.bufnr, line = line, lineCount = line_count })
end

function M.stop()
  if state.buf_handle then
    buffer.detach(state.buf_handle)
    state.buf_handle = nil
  end
  pcall(vim.api.nvim_del_augroup_by_name, 'ShuntakaPreviewLifecycle')
  if state.job_id then
    local job_id = state.job_id
    state.job_id = nil
    job.stop(job_id)
  end
  state.bufnr, state.port = nil, nil
end

return M
