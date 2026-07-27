local M = {}

---@param bufnr integer
---@param opts table { debounce_ms: integer, on_update: fun(), on_cursor: fun() }
---@return table handle { augroup: integer, timer: uv_timer_t }
function M.attach(bufnr, opts)
  local augroup = vim.api.nvim_create_augroup('ShuntakaPreviewBuffer', { clear = true })
  local timer = vim.uv.new_timer()

  vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, {
    group = augroup,
    buffer = bufnr,
    callback = function()
      timer:stop()
      timer:start(opts.debounce_ms, 0, vim.schedule_wrap(opts.on_update))
    end,
  })

  -- カーソル移動は変換を伴わないためデバウンスせず即送信する
  vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
    group = augroup,
    buffer = bufnr,
    callback = opts.on_cursor,
  })

  return { augroup = augroup, timer = timer }
end

function M.detach(handle)
  pcall(vim.api.nvim_del_augroup_by_id, handle.augroup)
  if handle.timer then
    handle.timer:stop()
    handle.timer:close()
  end
end

return M
