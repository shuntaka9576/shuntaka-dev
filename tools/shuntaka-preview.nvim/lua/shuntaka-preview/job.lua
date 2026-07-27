local M = {}

-- jobstart の on_stdout はストリーム都合で行が分割されて届くことがあるため、
-- 末尾の未完行をバッファに持ち越して行単位で処理する
local function line_reader(on_line)
  local pending = ''
  return function(_, data)
    if not data then
      return
    end
    data[1] = pending .. data[1]
    pending = table.remove(data)
    for _, line in ipairs(data) do
      if line ~= '' then
        on_line(line)
      end
    end
  end
end

---@param root_dir string プラグインルート (tools/shuntaka-preview.nvim)
---@param opts table { bun_cmd: string, port: integer, articles_dir: string? }
---@param callbacks table { on_ready: fun(port: integer), on_open: fun(path: string), on_debug: fun(line: string), on_exit: fun(code: integer) }
---@return integer job_id
function M.start(root_dir, opts, callbacks)
  local env = {}
  if opts.port ~= 0 then
    env.SHUNTAKA_PREVIEW_PORT = tostring(opts.port)
  end
  if opts.articles_dir then
    env.SHUNTAKA_PREVIEW_ARTICLES_DIR = vim.fn.expand(opts.articles_dir)
  end
  if next(env) == nil then
    env = nil
  end
  return vim.fn.jobstart({ opts.bun_cmd, root_dir .. '/src/index.ts' }, {
    cwd = root_dir,
    env = env,
    on_stdout = line_reader(function(line)
      local ok, msg = pcall(vim.json.decode, line)
      if ok and type(msg) == 'table' and msg.type == 'ready' then
        callbacks.on_ready(msg.port)
      elseif ok and type(msg) == 'table' and msg.type == 'open' then
        callbacks.on_open(msg.path)
      else
        callbacks.on_debug(line)
      end
    end),
    on_stderr = line_reader(callbacks.on_debug),
    on_exit = function(_, code)
      callbacks.on_exit(code)
    end,
  })
end

function M.send(job_id, tbl)
  pcall(vim.fn.chansend, job_id, vim.json.encode(tbl) .. '\n')
end

-- 明示終了メッセージを送り、一定時間で死ななければ jobstop で強制終了する
function M.stop(job_id)
  M.send(job_id, { type = 'shutdown' })
  vim.defer_fn(function()
    pcall(vim.fn.jobstop, job_id)
  end, 500)
end

return M
