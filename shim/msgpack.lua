---@diagnostic disable: lowercase-global
do
  ---@class FxMsgpack
  ---@field pack fun(value: any): string
  ---@field unpack fun(data: string): any
  ---@field pack_args fun(...: any): string
  ---@field unpack_args fun(data: string): any ...

  local MAX_DEPTH <const> = 128
  local EXT_VEC2 <const>, EXT_VEC3 <const>, EXT_VEC4 <const>, EXT_QUAT <const> = 20, 21, 22, 23

  local spack <const>, sunpack <const>, packsize <const> = string.pack, string.unpack, string.packsize
  local sbyte <const>, schar <const>, ssub <const> = string.byte, string.char, string.sub
  local mtype <const> = math.type

  ---@type table<string, integer>
  local EXT_BY_NAME <const> = { vector2 = EXT_VEC2, vector3 = EXT_VEC3, Vector3 = EXT_VEC3, vector4 = EXT_VEC4, quat = EXT_QUAT }
  ---@type table<integer, string[]>
  local EXT_KEYS <const> = {
    [EXT_VEC2] = { 'x', 'y' }, [EXT_VEC3] = { 'x', 'y', 'z' },
    [EXT_VEC4] = { 'x', 'y', 'z', 'w' }, [EXT_QUAT] = { 'x', 'y', 'z', 'w' },
  }

  ---@param value any
  ---@return string?
  local function vectorName(value)
    local kind <const> = type(value)
    if kind == 'vector3' then return 'vector3' end
    if kind ~= 'table' then return nil end
    local mt <const> = getmetatable(value)
    local name <const> = type(mt) == 'table' and mt.__name or nil
    return EXT_BY_NAME[name] ~= nil and name or nil
  end

  ---@param out string[]
  ---@param n integer
  ---@param fix integer
  ---@param tag16 integer
  ---@param tag32 integer
  local function packHeader(out, n, fix, tag16, tag32)
    if n <= 15 then out[#out + 1] = schar(fix + n)
    elseif n <= 0xffff then out[#out + 1] = spack('>B I2', tag16, n)
    else out[#out + 1] = spack('>B I4', tag32, n) end
  end

  ---@param out string[]
  ---@param value integer
  local function packInteger(out, value)
    if value >= 0 then
      if value <= 0x7f then out[#out + 1] = schar(value)
      elseif value <= 0xff then out[#out + 1] = spack('>B B', 0xcc, value)
      elseif value <= 0xffff then out[#out + 1] = spack('>B I2', 0xcd, value)
      elseif value <= 0xffffffff then out[#out + 1] = spack('>B I4', 0xce, value)
      else out[#out + 1] = spack('>B i8', 0xcf, value) end
    elseif value >= -32 then out[#out + 1] = schar(value & 0xff)
    elseif value >= -0x80 then out[#out + 1] = spack('>B i1', 0xd0, value)
    elseif value >= -0x8000 then out[#out + 1] = spack('>B i2', 0xd1, value)
    elseif value >= -0x80000000 then out[#out + 1] = spack('>B i4', 0xd2, value)
    else out[#out + 1] = spack('>B i8', 0xd3, value) end
  end

  ---@param out string[]
  ---@param value string
  local function packString(out, value)
    local n <const> = #value
    if n <= 31 then out[#out + 1] = schar(0xa0 + n)
    elseif n <= 0xff then out[#out + 1] = spack('>B B', 0xd9, n)
    elseif n <= 0xffff then out[#out + 1] = spack('>B I2', 0xda, n)
    else out[#out + 1] = spack('>B I4', 0xdb, n) end
    out[#out + 1] = value
  end

  ---@param out string[]
  ---@param ext integer
  ---@param value any
  local function packVector(out, ext, value)
    local keys <const> = EXT_KEYS[ext]
    local size <const> = #keys * 4
    if size == 8 then out[#out + 1] = spack('>B b', 0xd7, ext)
    elseif size == 16 then out[#out + 1] = spack('>B b', 0xd8, ext)
    else out[#out + 1] = spack('>B B b', 0xc7, size, ext) end
    for i = 1, #keys do out[#out + 1] = spack('<f', value[keys[i]]) end
  end

  ---@type fun(out: string[], value: any, depth: integer)
  local packValue

  ---@param out string[]
  ---@param value table
  ---@param depth integer
  local function packTable(out, value, depth)
    local count, isArray = 0, true
    for k in pairs(value) do
      count = count + 1
      if mtype(k) ~= 'integer' or k < 1 then isArray = false end
    end
    if isArray then
      for i = 1, count do
        if value[i] == nil then isArray = false break end
      end
    end
    if isArray then
      packHeader(out, count, 0x90, 0xdc, 0xdd)
      for i = 1, count do packValue(out, value[i], depth + 1) end
      return
    end
    packHeader(out, count, 0x80, 0xde, 0xdf)
    for k, v in pairs(value) do
      packValue(out, k, depth + 1)
      packValue(out, v, depth + 1)
    end
  end

  ---@param out string[]
  ---@param value any
  ---@param depth integer
  function packValue(out, value, depth)
    if depth > MAX_DEPTH then error('msgpack: cannot pack, depth limit exceeded (cyclic table?)', 0) end
    local kind <const> = type(value)
    if kind == 'nil' then out[#out + 1] = '\xc0'
    elseif kind == 'boolean' then out[#out + 1] = value and '\xc3' or '\xc2'
    elseif kind == 'number' then
      if mtype(value) == 'integer' then packInteger(out, value)
      else out[#out + 1] = spack('>B d', 0xcb, value) end
    elseif kind == 'string' then packString(out, value)
    else
      local name <const> = vectorName(value)
      if name ~= nil then packVector(out, EXT_BY_NAME[name], value)
      elseif kind == 'table' then packTable(out, value, depth)
      else error('msgpack: cannot pack a ' .. kind, 0) end
    end
  end

  ---@param data string
  ---@param pos integer
  ---@param n integer
  local function need(data, pos, n)
    if pos + n - 1 > #data then error('msgpack: unexpected end of data', 0) end
  end

  ---@type fun(data: string, pos: integer, depth: integer): any, integer
  local unpackValue

  ---@param data string
  ---@param pos integer
  ---@param count integer
  ---@param depth integer
  ---@return table
  ---@return integer
  local function unpackArray(data, pos, count, depth)
    local t <const> = {}
    for i = 1, count do
      local v
      v, pos = unpackValue(data, pos, depth + 1)
      t[i] = v
    end
    return t, pos
  end

  ---@param data string
  ---@param pos integer
  ---@param count integer
  ---@param depth integer
  ---@return table
  ---@return integer
  local function unpackMap(data, pos, count, depth)
    local t <const> = {}
    for _ = 1, count do
      local k, v
      k, pos = unpackValue(data, pos, depth + 1)
      v, pos = unpackValue(data, pos, depth + 1)
      if k ~= nil then t[k] = v end
    end
    return t, pos
  end

  ---@param data string
  ---@param pos integer
  ---@param size integer
  ---@return string
  ---@return integer
  local function unpackBytes(data, pos, size)
    need(data, pos, size)
    return ssub(data, pos, pos + size - 1), pos + size
  end

  ---@param data string
  ---@param pos integer
  ---@param size integer
  ---@return any
  ---@return integer
  local function unpackExt(data, pos, size)
    need(data, pos, size + 1)
    local ext <const> = sunpack('>b', data, pos)
    local keys <const> = EXT_KEYS[ext]
    pos = pos + 1
    if keys == nil or size ~= #keys * 4 then return ssub(data, pos, pos + size - 1), pos + size end
    local c <const> = {}
    for i = 1, #keys do c[i] = sunpack('<f', data, pos + (i - 1) * 4) end
    local make <const> = ext == EXT_VEC2 and vector2 or ext == EXT_VEC3 and vector3
      or ext == EXT_VEC4 and vector4 or quat
    return make(table.unpack(c, 1, #keys)), pos + size
  end

  ---@type table<integer, string>
  local SCALARS <const> = {
    [0xca] = '>f', [0xcb] = '>d', [0xcc] = '>B', [0xcd] = '>I2', [0xce] = '>I4',
    [0xd0] = '>i1', [0xd1] = '>i2', [0xd2] = '>i4', [0xd3] = '>i8',
  }
  ---@type table<integer, integer>
  local FIXEXT <const> = { [0xd4] = 1, [0xd5] = 2, [0xd6] = 4, [0xd7] = 8, [0xd8] = 16 }
  ---@type table<integer, string>
  local LENGTHS <const> = {
    [0xc4] = '>B', [0xc5] = '>I2', [0xc6] = '>I4', [0xc7] = '>B', [0xc8] = '>I2', [0xc9] = '>I4',
    [0xd9] = '>B', [0xda] = '>I2', [0xdb] = '>I4', [0xdc] = '>I2', [0xdd] = '>I4', [0xde] = '>I2', [0xdf] = '>I4',
  }

  ---@param data string
  ---@param pos integer
  ---@param depth integer
  ---@return any
  ---@return integer
  function unpackValue(data, pos, depth)
    if depth > MAX_DEPTH then error('msgpack: depth limit exceeded', 0) end
    need(data, pos, 1)
    local tag <const> = sbyte(data, pos)
    pos = pos + 1
    if tag <= 0x7f then return tag, pos end
    if tag >= 0xe0 then return tag - 0x100, pos end
    if tag <= 0x8f then return unpackMap(data, pos, tag & 0x0f, depth) end
    if tag <= 0x9f then return unpackArray(data, pos, tag & 0x0f, depth) end
    if tag <= 0xbf then return unpackBytes(data, pos, tag & 0x1f) end
    if tag == 0xc0 then return nil, pos end
    if tag == 0xc2 then return false, pos end
    if tag == 0xc3 then return true, pos end
    local scalar <const> = SCALARS[tag]
    if scalar ~= nil then
      need(data, pos, packsize(scalar))
      return sunpack(scalar, data, pos)
    end
    if tag == 0xcf then
      need(data, pos, 8)
      local v <const>, nextPos <const> = sunpack('>i8', data, pos)
      if v < 0 then return (v + 0.0) + 18446744073709551616.0, nextPos end
      return v, nextPos
    end
    local fixed <const> = FIXEXT[tag]
    if fixed ~= nil then return unpackExt(data, pos, fixed) end
    local lenFmt <const> = LENGTHS[tag]
    if lenFmt == nil then error(string.format('msgpack: unsupported type 0x%02x', tag), 0) end
    need(data, pos, packsize(lenFmt))
    local len <const>, afterLen <const> = sunpack(lenFmt, data, pos)
    if tag == 0xdc or tag == 0xdd then return unpackArray(data, afterLen, len, depth) end
    if tag == 0xde or tag == 0xdf then return unpackMap(data, afterLen, len, depth) end
    if tag >= 0xc7 and tag <= 0xc9 then return unpackExt(data, afterLen, len) end
    return unpackBytes(data, afterLen, len)
  end

  ---@type FxMsgpack
  local codec <const> = {} ---@diagnostic disable-line: missing-fields

  ---@param value any
  ---@return string
  function codec.pack(value)
    local out <const> = {}
    packValue(out, value, 1)
    return table.concat(out)
  end

  ---@param data string
  ---@return any
  function codec.unpack(data)
    if type(data) ~= 'string' then error("bad argument #1 to 'unpack' (string expected)", 2) end
    local value <const> = unpackValue(data, 1, 1)
    return value
  end

  --- The arguments travel as an array with an explicit count, so nil holes survive.
  ---@param ... any
  ---@return string
  function codec.pack_args(...)
    local n <const> = select('#', ...)
    local out <const> = {}
    packHeader(out, n, 0x90, 0xdc, 0xdd)
    for i = 1, n do packValue(out, (select(i, ...)), 2) end
    return table.concat(out)
  end

  ---@param data string
  ---@return any ...
  function codec.unpack_args(data)
    if type(data) ~= 'string' then error("bad argument #1 to 'unpack_args' (string expected)", 2) end
    local tag <const> = sbyte(data, 1)
    local count, pos
    if tag ~= nil and tag >= 0x90 and tag <= 0x9f then count, pos = tag & 0x0f, 2
    elseif tag == 0xdc then count, pos = sunpack('>I2', data, 2)
    elseif tag == 0xdd then count, pos = sunpack('>I4', data, 2)
    else error('msgpack: unpack_args expects an array', 0) end
    local t <const> = unpackArray(data, pos, count, 2)
    return table.unpack(t, 1, count)
  end

  if type(msgpack) ~= 'table' then msgpack = codec end
end
