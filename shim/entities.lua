---@diagnostic disable: lowercase-global
do
  local lsmp <const> = lsmp
  -- Wire protocol, identical for every language shim:
  --   server -> owner client, event EVENT: { netId = integer, ops = FxEntityOp[] }, netId 0 = the receiving player
  --   server -> owner client, call QUERY(netId, field), field = 'heading'|'health'|'plate'|'velocity'|'armour', result nil when
  --   the callee does not own the entity or cannot read it, velocity is { x, y, z }
  local EVENT <const> = 'fxcompat:ent:' .. FXC.resource
  local QUERY <const> = 'fxcompat:entq:' .. FXC.resource

  ---@class FxEntityOp
  ---@field op 'state'|'coords'|'heading'|'velocity'|'warp'|'weapon'|'clearWeapons'|'armour'|'health'|'playerModel'|'removeWeapon'|'component'|'ammo'
  ---@field plate string?
  ---@field locks integer?
  ---@field frozen boolean?
  ---@field x number?
  ---@field y number?
  ---@field z number?
  ---@field h number?
  ---@field value number?
  ---@field vehicle integer? netId of the vehicle
  ---@field seat integer?
  ---@field hash integer? weapon hash
  ---@field component integer? weapon component hash
  ---@field ammo integer?
  ---@field model integer?

  ---@class FxEntityMessage
  ---@field netId integer
  ---@field ops FxEntityOp[]

  if FXC.side == 'server' then
    local MAX_QUEUE <const> = 32

    ---@class FxEntityRecord
    ---@field model integer?
    ---@field plate string?
    ---@field locks integer?
    ---@field frozen boolean?
    ---@field health number?
    ---@field armour number?
    ---@field heading number?
    ---@field velocity { x: number, y: number, z: number }?
    ---@field queue FxEntityOp[] one-shot actions waiting for an owner

    ---@type table<integer, FxEntityRecord>
    local records = {}

    ---@type table<string, true>
    local COALESCED <const> = { coords = true, heading = true, velocity = true, armour = true, health = true }

    ---@param model any
    ---@return (integer|string)? model hash or model name, nil when invalid
    local function toModel(model)
      if type(model) == 'string' then
        local n = tonumber(model)
        if n == nil then return model end
        model = n
      end
      local n = math.tointeger(model)
      if n == nil then return nil end
      n = n % 4294967296
      if n == 0 then return nil end
      return n
    end

    ---@param value any
    ---@return integer?
    local function toHash(value)
      if type(value) == 'string' and tonumber(value) == nil then return lsmp.hash(value) end
      local n = math.tointeger(tonumber(value))
      return n and n % 4294967296 or nil
    end

    ---@param netId any
    ---@return FxEntityRecord?
    local function recordOf(netId)
      if math.type(netId) ~= 'integer' then return nil end
      if not lsmp.entityExists(netId) then
        records[netId] = nil
        return nil
      end
      ---@type FxEntityRecord?
      local rec = records[netId]
      local model = lsmp.getEntityModel(netId)
      -- LS:MP reuses a netId after a delete
      if rec ~= nil and rec.model ~= nil and model ~= nil and rec.model ~= model then rec = nil end
      if rec == nil then
        rec = { model = model, queue = {} }
        records[netId] = rec
      end
      return rec
    end

    ---@param owner integer
    ---@param netId integer
    ---@param ops FxEntityOp[]
    local function send(owner, netId, ops)
      lsmp.emitClient(owner, EVENT, { netId = netId, ops = ops })
    end

    ---@param rec FxEntityRecord
    ---@return FxEntityOp?
    local function stateOp(rec)
      if rec.plate == nil and rec.locks == nil and rec.frozen == nil then return nil end
      return { op = 'state', plate = rec.plate, locks = rec.locks, frozen = rec.frozen }
    end

    ---@param netId integer
    ---@param rec FxEntityRecord
    ---@param owner integer
    local function flush(netId, rec, owner)
      ---@type FxEntityOp[]
      local ops = {}
      local state = stateOp(rec)
      if state ~= nil then ops[1] = state end
      for _, op in ipairs(rec.queue) do ops[#ops + 1] = op end
      rec.queue = {}
      if #ops > 0 then send(owner, netId, ops) end
    end

    ---@param netId integer
    ---@param rec FxEntityRecord
    ---@param op FxEntityOp
    local function submit(netId, rec, op)
      local owner = lsmp.getEntityOwner(netId)
      if owner ~= nil then return send(owner, netId, { op }) end
      local queue = rec.queue
      if COALESCED[op.op] then
        for i, queued in ipairs(queue) do
          if queued.op == op.op then
            queue[i] = op
            return
          end
        end
      end
      if #queue >= MAX_QUEUE then table.remove(queue, 1) end
      queue[#queue + 1] = op
    end

    ---@param netId integer
    ---@param rec FxEntityRecord
    ---@param fields FxEntityOp persistent fields, already stored in rec
    local function submitState(netId, rec, fields)
      local owner = lsmp.getEntityOwner(netId)
      if owner ~= nil then send(owner, netId, { fields }) end
    end

    ---@param kind 'vehicle'|'ped'|'object'
    ---@param model any
    ---@param x number
    ---@param y number
    ---@param z number
    ---@param heading number?
    ---@return integer
    local function create(kind, model, x, y, z, heading)
      local resolved = toModel(model)
      if resolved == nil then return 0 end
      ---@type LsmpCreateEntityOptions
      local opts = { lifePolicy = 'keep' }
      if kind ~= 'object' and heading ~= nil then opts.heading = heading + 0.0 end
      local netId, code = lsmp.createEntity(kind, resolved, { x = (x or 0) + 0.0, y = (y or 0) + 0.0, z = (z or 0) + 0.0 }, opts)
      if netId == nil then
        lsmp.warn('[fxcompat] createEntity(' .. kind .. ') failed: ' .. tostring(code))
        return 0
      end
      records[netId] = { model = lsmp.getEntityModel(netId), heading = opts.heading, queue = {} }
      return netId
    end

    ---@param model any
    ---@param _type any
    ---@param x number
    ---@param y number
    ---@param z number
    ---@param heading number
    ---@return integer
    function CreateVehicleServerSetter(model, _type, x, y, z, heading) return create('vehicle', model, x, y, z, heading) end

    ---@param model any
    ---@param x number
    ---@param y number
    ---@param z number
    ---@param heading number
    ---@return integer
    function CreateVehicle(model, x, y, z, heading) return create('vehicle', model, x, y, z, heading) end

    ---@param _pedType any
    ---@param model any
    ---@param x number
    ---@param y number
    ---@param z number
    ---@param heading number
    ---@return integer
    function CreatePed(_pedType, model, x, y, z, heading) return create('ped', model, x, y, z, heading) end

    ---@param model any
    ---@param x number
    ---@param y number
    ---@param z number
    ---@return integer
    function CreateObject(model, x, y, z) return create('object', model, x, y, z) end

    CreateObjectNoOffset = CreateObject

    ---@param entity integer
    function DeleteEntity(entity)
      if math.type(entity) == 'integer' then records[entity] = nil end
      lsmp.deleteEntity(entity)
    end

    ---@param entity integer
    ---@param x number
    ---@param y number
    ---@param z number
    function SetEntityCoords(entity, x, y, z)
      local rec = recordOf(entity)
      if rec == nil then return end
      submit(entity, rec, { op = 'coords', x = x + 0.0, y = y + 0.0, z = z + 0.0 })
    end

    SetEntityCoordsNoOffset = SetEntityCoords

    ---@param entity integer
    ---@param heading number
    function SetEntityHeading(entity, heading)
      local rec = recordOf(entity)
      if rec == nil then return end
      rec.heading = heading + 0.0
      submit(entity, rec, { op = 'heading', h = heading + 0.0 })
    end

    ---@param entity integer
    ---@param toggle boolean
    function FreezeEntityPosition(entity, toggle)
      local rec = recordOf(entity)
      if rec == nil then return end
      rec.frozen = toggle and true or false
      submitState(entity, rec, { op = 'state', frozen = rec.frozen })
    end

    ---@param entity integer
    ---@param x number
    ---@param y number
    ---@param z number
    function SetEntityVelocity(entity, x, y, z)
      local rec = recordOf(entity)
      if rec == nil then return end
      rec.velocity = { x = x + 0.0, y = y + 0.0, z = z + 0.0 }
      submit(entity, rec, { op = 'velocity', x = x + 0.0, y = y + 0.0, z = z + 0.0 })
    end

    ---@param vehicle integer
    ---@param text string
    function SetVehicleNumberPlateText(vehicle, text)
      local rec = recordOf(vehicle)
      if rec == nil then return end
      rec.plate = tostring(text)
      submitState(vehicle, rec, { op = 'state', plate = rec.plate })
    end

    ---@param vehicle integer
    ---@param status integer
    function SetVehicleDoorsLocked(vehicle, status)
      local rec = recordOf(vehicle)
      if rec == nil then return end
      rec.locks = math.tointeger(status) or 0
      submitState(vehicle, rec, { op = 'state', locks = rec.locks })
    end

    ---@param ped integer
    ---@param vehicle integer
    ---@param seat integer
    function SetPedIntoVehicle(ped, vehicle, seat)
      local rec = recordOf(ped)
      if rec == nil then return end
      submit(ped, rec, { op = 'warp', vehicle = vehicle, seat = math.tointeger(seat) or -1 })
    end

    ---@param ped integer
    ---@param vehicle integer
    ---@param seat integer
    function TaskWarpPedIntoVehicle(ped, vehicle, seat) SetPedIntoVehicle(ped, vehicle, seat) end

    --- The ped is created at the vehicle position, then seated by its owner once it owns both.
    ---@param vehicle integer
    ---@param _pedType any
    ---@param model any
    ---@param seat integer
    ---@return integer
    function CreatePedInsideVehicle(vehicle, _pedType, model, seat)
      local at = lsmp.entityExists(vehicle) and lsmp.getEntityCoords(vehicle) or nil
      if at == nil then return 0 end
      local ped = create('ped', model, at.x, at.y, at.z, 0.0)
      if ped ~= 0 then SetPedIntoVehicle(ped, vehicle, seat) end
      return ped
    end

    ---@param ped integer
    ---@param weapon integer|string
    ---@param ammo integer
    function GiveWeaponToPed(ped, weapon, ammo)
      local rec = recordOf(ped)
      local hash = toHash(weapon)
      if rec == nil or hash == nil then return end
      submit(ped, rec, { op = 'weapon', hash = hash, ammo = math.tointeger(ammo) or 0 })
    end

    ---@param ped integer
    ---@param weapon integer|string
    ---@param component integer|string
    function GiveWeaponComponentToPed(ped, weapon, component)
      local rec = recordOf(ped)
      local hash = toHash(weapon)
      local componentHash = toHash(component)
      if rec == nil or hash == nil or componentHash == nil then return end
      submit(ped, rec, { op = 'component', hash = hash, component = componentHash })
    end

    ---@param ped integer
    ---@param weapon integer|string
    function RemoveWeaponFromPed(ped, weapon)
      local rec = recordOf(ped)
      local hash = toHash(weapon)
      if rec == nil or hash == nil then return end
      submit(ped, rec, { op = 'removeWeapon', hash = hash })
    end

    ---@param ped integer
    ---@param weapon integer|string
    ---@param ammo integer
    function SetPedAmmo(ped, weapon, ammo)
      local rec = recordOf(ped)
      local hash = toHash(weapon)
      if rec == nil or hash == nil then return end
      submit(ped, rec, { op = 'ammo', hash = hash, ammo = math.tointeger(ammo) or 0 })
    end

    ---@param ped integer
    function RemoveAllPedWeapons(ped)
      local rec = recordOf(ped)
      if rec == nil then return end
      submit(ped, rec, { op = 'clearWeapons' })
    end

    ---@param ped integer
    ---@param amount number
    function SetPedArmour(ped, amount)
      local rec = recordOf(ped)
      if rec == nil then return end
      rec.armour = amount + 0.0
      submit(ped, rec, { op = 'armour', value = amount + 0.0 })
    end

    ---@param entity integer
    ---@param health number
    function SetEntityHealth(entity, health)
      local rec = recordOf(entity)
      if rec == nil then return end
      rec.health = health + 0.0
      submit(entity, rec, { op = 'health', value = health + 0.0 })
    end

    ---@param src integer|string
    ---@param model integer|string
    function SetPlayerModel(src, model)
      local id = FXC.toLsmp(src)
      local hash = toHash(model)
      if id == nil or hash == nil then return end
      send(id, 0, { { op = 'playerModel', model = hash } })
    end

    ---@param entity integer
    ---@param bucket integer
    function SetEntityRoutingBucket(entity, bucket) lsmp.setEntityDimension(entity, bucket) end

    ---@param entity integer
    ---@return integer
    function GetEntityRoutingBucket(entity) return lsmp.getEntityDimension(entity) or 0 end

    ---@param entity integer
    ---@return integer
    function GetEntityModel(entity) return lsmp.getEntityModel(entity) or 0 end

    --- FiveM numbering: 1 ped, 2 vehicle, 3 object, 0 none.
    ---@type table<string, integer>
    local TYPE_IDS <const> = { ped = 1, playerPed = 1, vehicle = 2, object = 3 }

    ---@param entity integer
    ---@return integer
    function GetEntityType(entity)
      local kind = lsmp.entityExists(entity) and lsmp.getEntityType(entity) or nil
      return kind and TYPE_IDS[kind] or 0
    end

    ---@param entity integer
    ---@return integer
    function NetworkGetEntityOwner(entity)
      local owner <const> = lsmp.getEntityOwner(entity)
      return owner ~= nil and FXC.toFiveM(owner) or -1
    end

    --- Asks the owner client; nil outside a host coroutine, without owner or when the owner cannot answer.
    ---@param netId integer
    ---@param field string
    ---@return any
    local function ask(netId, field)
      local owner = lsmp.getEntityOwner(netId)
      if owner == nil then return nil end
      local ok, value = pcall(lsmp.callClient, owner, QUERY, netId, field)
      if not ok then
        FXC.warnOnce('ent-await', 'reading ' .. field .. ' from the owner needs a coroutine, returning the last value set')
        return nil
      end
      return value
    end

    ---@param entity integer
    ---@return number
    function GetEntityHeading(entity)
      local rec = recordOf(entity)
      if rec == nil then return 0.0 end
      local value = ask(entity, 'heading')
      if type(value) == 'number' then rec.heading = value end
      return rec.heading or 0.0
    end

    ---@param entity integer
    ---@return number
    function GetEntityHealth(entity)
      local rec = recordOf(entity)
      if rec == nil then return 0 end
      local value = ask(entity, 'health')
      if type(value) == 'number' then rec.health = value end
      return rec.health or 0
    end

    ---@param ped integer
    ---@return integer
    function GetPedArmour(ped)
      local rec = recordOf(ped)
      if rec == nil then return 0 end
      local value = ask(ped, 'armour')
      if type(value) == 'number' then rec.armour = value end
      return math.floor(rec.armour or 0)
    end

    ---@param vehicle integer
    ---@return string
    function GetVehicleNumberPlateText(vehicle)
      local rec = recordOf(vehicle)
      if rec == nil then return '' end
      local value = ask(vehicle, 'plate')
      if type(value) == 'string' then rec.plate = value end
      return rec.plate or ''
    end

    ---@param entity integer
    ---@return any vector3
    function GetEntityVelocity(entity)
      local rec = recordOf(entity)
      if rec == nil then return vector3(0.0, 0.0, 0.0) end
      local value = ask(entity, 'velocity')
      if type(value) == 'table' and type(value.x) == 'number' and type(value.y) == 'number' and type(value.z) == 'number' then
        rec.velocity = { x = value.x, y = value.y, z = value.z }
      end
      local v = rec.velocity
      if v == nil then return vector3(0.0, 0.0, 0.0) end
      return vector3(v.x, v.y, v.z)
    end

    --- Seat -1 is the driver in FiveM and 0 in LS:MP.
    ---@param vehicle integer
    ---@param seat integer
    ---@return integer
    function GetPedInVehicleSeat(vehicle, seat)
      if not lsmp.entityExists(vehicle) then return 0 end
      return lsmp.getPedInVehicleSeat(vehicle, (math.tointeger(seat) or -1) + 1) or 0
    end

    ---@param ped integer
    ---@return integer
    function GetVehiclePedIsIn(ped)
      if not lsmp.entityExists(ped) then return 0 end
      return lsmp.getVehiclePedIsIn(ped) or 0
    end

    ---@return integer[]
    function GetAllVehicles() return lsmp.getEntities({ types = { 'vehicle' } }) end

    lsmp.on('entityOwnerChange', function(netId, _, newOwner)
      local rec = records[netId]
      if rec == nil then return end
      if not lsmp.entityExists(netId) then
        records[netId] = nil
        return
      end
      if newOwner ~= nil then flush(netId, rec, newOwner) end
    end)

    lsmp.on('resourceStop', function(name)
      if name == FXC.resource then records = {} end
    end)
  else
    local aliases <const> = NATIVES_ALIAS
    ---@type table<string, fun(...: any): ...>
    local G <const> = _G
    local RETRIES <const> = 30
    local RETRY_MS <const> = 100

    ---@param name string
    ---@return fun(...: any): ...
    local function native(name)
      local fn = G[aliases[name] or (name:sub(1, 1):lower() .. name:sub(2))]
      if fn == nil then error('native ' .. name .. ' is not available', 0) end
      return fn
    end

    ---@param netId integer
    ---@return integer?
    local function handleOf(netId)
      local handle = lsmp.getEntityFromNetId(netId)
      if math.type(handle) == 'integer' and handle ~= 0 then return handle end
      return nil
    end

    ---@param netId integer
    ---@return boolean
    local function owns(netId) return lsmp.getEntityOwner(netId) == lsmp.getLocalPlayer() end

    ---@type table<string, fun(handle: integer, op: FxEntityOp)>
    local ACTIONS <const> = {
      state = function(handle, op)
        if op.plate ~= nil then native('SetVehicleNumberPlateText')(handle, op.plate) end
        if op.locks ~= nil then native('SetVehicleDoorsLocked')(handle, op.locks) end
        if op.frozen ~= nil then native('FreezeEntityPosition')(handle, op.frozen) end
      end,
      coords = function(handle, op) native('SetEntityCoords')(handle, op.x, op.y, op.z, false, false, false, false) end,
      heading = function(handle, op) native('SetEntityHeading')(handle, op.h) end,
      velocity = function(handle, op) native('SetEntityVelocity')(handle, op.x, op.y, op.z) end,
      warp = function(handle, op)
        local vehicle = nil
        for _ = 1, RETRIES do
          vehicle = handleOf(op.vehicle)
          if vehicle ~= nil then break end
          lsmp.wait(RETRY_MS)
        end
        if vehicle == nil then error('vehicle ' .. tostring(op.vehicle) .. ' is not streamed in', 0) end
        native('SetPedIntoVehicle')(handle, vehicle, op.seat)
      end,
      weapon = function(handle, op) native('GiveWeaponToPed')(handle, op.hash, op.ammo, false, true) end,
      clearWeapons = function(handle) native('RemoveAllPedWeapons')(handle, true) end,
      removeWeapon = function(handle, op) native('RemoveWeaponFromPed')(handle, op.hash) end,
      component = function(handle, op) native('GiveWeaponComponentToPed')(handle, op.hash, op.component) end,
      ammo = function(handle, op) native('SetPedAmmo')(handle, op.hash, op.ammo) end,
      armour = function(handle, op) native('SetPedArmour')(handle, math.floor(op.value)) end,
      health = function(handle, op) native('SetEntityHealth')(handle, math.floor(op.value)) end,
    }

    ---@param handle integer
    ---@param op FxEntityOp
    local function apply(handle, op)
      local action = ACTIONS[op.op]
      if action == nil then return end
      local ok, err = pcall(action, handle, op)
      if not ok then lsmp.warn('[fxcompat] entity op ' .. tostring(op.op) .. ' failed: ' .. tostring(err)) end
    end

    ---@param model integer
    local function applyPlayerModel(model)
      local ok, err = pcall(function()
        native('RequestModel')(model)
        local waited = 0
        while not native('HasModelLoaded')(model) and waited < 5000 do
          lsmp.wait(50)
          waited = waited + 50
        end
        native('SetPlayerModel')(native('PlayerId')(), model)
        native('SetModelAsNoLongerNeeded')(model)
      end)
      if not ok then lsmp.warn('[fxcompat] SetPlayerModel failed: ' .. tostring(err)) end
    end

    ---@param netId integer
    ---@param ops FxEntityOp[]
    local function run(netId, ops)
      for _ = 1, RETRIES do
        if owns(netId) then
          local handle = handleOf(netId)
          if handle ~= nil then
            for _, op in ipairs(ops) do apply(handle, op) end
            return
          end
        end
        lsmp.wait(RETRY_MS)
      end
    end

    lsmp.onServer(EVENT, function(msg)
      if type(msg) ~= 'table' or math.type(msg.netId) ~= 'integer' or type(msg.ops) ~= 'table' then return end
      if msg.netId == 0 then
        for _, op in ipairs(msg.ops) do
          if op.op == 'playerModel' and math.type(op.model) == 'integer' then
            lsmp.createThread(applyPlayerModel, op.model)
          end
        end
        return
      end
      lsmp.createThread(run, msg.netId, msg.ops)
    end)

    ---@type table<string, fun(handle: integer): any>
    local READERS <const> = {
      heading = function(handle) return native('GetEntityHeading')(handle) end,
      health = function(handle) return native('GetEntityHealth')(handle) end,
      plate = function(handle) return native('GetVehicleNumberPlateText')(handle) end,
      armour = function(handle) return native('GetPedArmour')(handle) end,
      velocity = function(handle)
        local x, y, z = native('GetEntityVelocity')(handle)
        if type(x) == 'table' then return { x = x.x, y = x.y, z = x.z } end
        return { x = x, y = y, z = z }
      end,
    }

    lsmp.onCall(QUERY, function(netId, field)
      local reader = READERS[field]
      if reader == nil or math.type(netId) ~= 'integer' or not owns(netId) then return nil end
      local handle = handleOf(netId)
      if handle == nil then return nil end
      local ok, value = pcall(reader, handle)
      if not ok then return nil end
      return value
    end)
  end
end
