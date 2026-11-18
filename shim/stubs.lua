---@diagnostic disable: lowercase-global
do
  ---@alias FxStubKind 'bool'|'int'|'float'|'string'|'vector'|'nil'

  ---@type table<FxStubKind, fun(): any>
  local DEFAULTS <const> = {
    bool = function() return false end,
    int = function() return 0 end,
    float = function() return 0.0 end,
    string = function() return '' end,
    vector = function() return vector3(0.0, 0.0, 0.0) end,
    ['nil'] = function() return nil end,
  }

  ---@type table<FxStubKind, string>
  local RETURNS <const> = {
    bool = 'false', int = '0', float = '0.0', string = 'an empty string', vector = 'a zero vector', ['nil'] = 'nothing',
  }

  ---@type table<string, FxStubKind>
  local stubs <const> = (FXCOMPAT_CONFIG.stubs or {})[FXC.side] or {}
  for name, kind in pairs(stubs) do
    local default <const> = DEFAULTS[kind]
    if default ~= nil and type(rawget(_G, name)) ~= 'function' then
      local message <const> = name .. ' has no LS:MP counterpart: the call does nothing and returns ' .. RETURNS[kind]
      ---@return any
      rawset(_G, name, function()
        FXC.warnOnce('stub:' .. name, message)
        return default()
      end)
    end
  end
end
