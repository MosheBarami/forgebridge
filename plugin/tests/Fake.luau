--!nonstrict
--[[
	Fake — enough of a Roblox Instance to test against, and no more.

	Modelled on the two behaviours the plugin actually depends on:
	  * reading or writing a member a class does not have is an error, not nil.
	    Journal.capture leans on exactly that to refuse an operation whose previous
	    value it cannot read;
	  * setting Parent re-links the child lists, so path resolution sees the tree
	    move the way Studio would.
]]

local Fake = {}

local data = setmetatable({}, { __mode = "k" })

local Methods = {}

function Methods.FindFirstChild(proxy, name)
	for _, child in data[proxy].children do
		if data[child].fields.Name == name then
			return child
		end
	end
	return nil
end

function Methods.GetChildren(proxy)
	return table.clone(data[proxy].children)
end

function Methods.GetDescendants(proxy)
	local out = {}
	for _, child in data[proxy].children do
		table.insert(out, child)
		for _, descendant in Methods.GetDescendants(child) do
			table.insert(out, descendant)
		end
	end
	return out
end

function Methods.GetAttributes(proxy)
	return table.clone(data[proxy].attributes)
end

function Methods.SetAttribute(proxy, key, value)
	data[proxy].attributes[key] = value
end

function Methods.IsA(proxy, className)
	return data[proxy].fields.ClassName == className
end

function Methods.Clone(proxy)
	local self = data[proxy]
	if self.archivable == false then
		return nil
	end
	local copy = Fake.new(self.fields.ClassName, self.fields.Name, nil, self.permissive)
	for key, value in self.fields do
		if key ~= "Parent" then
			data[copy].fields[key] = value
			data[copy].valid[key] = true
		end
	end
	for key, value in self.attributes do
		data[copy].attributes[key] = value
	end
	for _, child in self.children do
		local childCopy = Methods.Clone(child)
		childCopy.Parent = copy
	end
	return copy
end

--[[
	Unlinks directly rather than assigning Parent, so a fake configured to refuse
	a Parent write (`Fake.refuse`) can still be destroyed — Destroy is the engine
	tearing an instance down, not an ordinary property assignment, and a plugin
	cleaning up after a refused write must not be blocked by that same refusal.
]]
function Methods.Destroy(proxy)
	local self = data[proxy]
	local previous = self.fields.Parent
	if previous ~= nil then
		local siblings = data[previous].children
		for index, child in siblings do
			if child == proxy then
				table.remove(siblings, index)
				break
			end
		end
	end
	self.fields.Parent = nil
	self.destroyed = true
end

function Methods.GetService(proxy, name)
	local service = Methods.FindFirstChild(proxy, name)
	if not service then
		error(string.format("%s is not a valid service", name), 0)
	end
	return service
end

--[[
	`props` seeds both the values and the set of members this fake admits.
	`permissive` models a freshly constructed Instance, where the caller may set
	whatever the real class supports.
]]
function Fake.new(className: string, name: string, props: any?, permissive: boolean?)
	-- An empty table with a metatable, so every read and write goes through
	-- __index/__newindex: a member never lands on the proxy itself, which is what
	-- makes "not a valid member" reachable for keys that were once written.
	local meta = {}
	local proxy = setmetatable({}, meta)

	local self = {
		fields = { ClassName = className, Name = name, Parent = nil },
		valid = { ClassName = true, Name = true, Parent = true },
		children = {},
		attributes = {},
		permissive = permissive == true,
		archivable = true,
		destroyed = false,
		-- Writes the engine refuses, keyed by property. See `Fake.refuse`.
		refusals = {},
	}
	for key, value in props or {} do
		self.fields[key] = value
		self.valid[key] = true
	end
	data[proxy] = self

	meta.__index = function(_, key)
		if Methods[key] then
			return Methods[key]
		end
		if not self.valid[key] then
			error(string.format("%s is not a valid member of %s", tostring(key), className), 0)
		end
		return self.fields[key]
	end

	meta.__newindex = function(_, key, value)
		-- Checked before Parent is special-cased, because Parent is the write the
		-- engine most often refuses (a locked parent, a class it will not accept
		-- there) and the plugin has to survive that like any other refusal.
		local refusal = self.refusals[key]
		if refusal ~= nil and (refusal.whenValue == nil or refusal.whenValue == value) then
			error(string.format("Something.luau:1: %s", refusal.message), 0)
		end
		if key == "Parent" then
			local previous = self.fields.Parent
			if previous ~= nil then
				local siblings = data[previous].children
				for index, child in siblings do
					if child == proxy then
						table.remove(siblings, index)
						break
					end
				end
			end
			self.fields.Parent = value
			if value ~= nil then
				table.insert(data[value].children, proxy)
			end
			return
		end
		if not self.valid[key] and not self.permissive then
			error(string.format("%s is not a valid member of %s", tostring(key), className), 0)
		end
		self.valid[key] = true
		self.fields[key] = value
	end

	meta.__tostring = function()
		return string.format("%s(%s)", className, name)
	end

	return proxy
end

--[[
	Make writes to `property` throw, the way the engine refuses one.

	The message is prefixed with a "file:line:" the way Luau errors are, so the
	plugin's own stripping of that prefix is exercised too. `whenValue` narrows
	the refusal to one assigned value, which is how a move that reparents
	successfully and then cannot be put back is modelled.
]]
function Fake.refuse(proxy, property: string, message: string, whenValue: any?)
	data[proxy].refusals[property] = { message = message, whenValue = whenValue }
end

--- Mark a fake as unclonable, the way Archivable = false behaves.
function Fake.setArchivable(proxy, archivable: boolean)
	data[proxy].archivable = archivable
end

function Fake.isDestroyed(proxy): boolean
	return data[proxy].destroyed
end

--[[
	A DataModel carrying the given services, each a fake with the service's own
	name. `Fake.dataModel({ "ServerScriptService" })`.
]]
function Fake.dataModel(services: { string })
	local root = Fake.new("DataModel", "game")
	for _, name in services do
		local service = Fake.new(name, name)
		service.Parent = root
	end
	return root
end

--- Build a chain of Folders under a service and return the deepest one.
function Fake.folders(root, path: string)
	local current = nil
	local segments = {}
	for segment in string.gmatch(path, "[^%.]+") do
		table.insert(segments, segment)
	end
	for index, segment in segments do
		if index == 1 then
			current = root:GetService(segment)
		else
			local child = current:FindFirstChild(segment)
			if not child then
				child = Fake.new("Folder", segment)
				child.Parent = current
			end
			current = child
		end
	end
	return current
end

--[[
	A deterministic JSON-ish encoder. The journal only needs the serialised form to
	be a stable string it can hand back later; the tests only need it to be
	comparable.
]]
function Fake.encodeJson(value: any): string
	local function encode(node: any): string
		local kind = type(node)
		if kind == "table" then
			local keys = {}
			for key in node do
				table.insert(keys, tostring(key))
			end
			table.sort(keys)
			local parts = {}
			for _, key in keys do
				table.insert(parts, string.format("%q:%s", key, encode(node[key] or node[tonumber(key)])))
			end
			return "{" .. table.concat(parts, ",") .. "}"
		elseif kind == "string" then
			return string.format("%q", node)
		end
		return tostring(node)
	end
	return encode(value)
end

return Fake
