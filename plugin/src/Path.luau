--!strict
--[[
	Path — resolving a protocol InstancePath against the DataModel.

	The protocol's InstancePath is deliberately restrictive (see
	packages/protocol/src/path.ts): a dotted chain of safe identifiers rooted at a
	service. This module re-validates every path on arrival instead of trusting
	that the server already did, because the plugin is the last thing standing
	between a ChangeSet and someone's place.

	Resolution NEVER creates. A missing ancestor is an error naming the segment
	that is missing: quietly creating one would let a typo in a model-authored
	path build a parallel tree that looks nothing like the diff the user approved.

	Instances are typed `any` on purpose — the unit tests substitute plain tables
	carrying FindFirstChild/GetService, which is the only way to exercise this
	module outside Studio.
]]

local Path = {}

local SEGMENT = "^[A-Za-z_][A-Za-z0-9_]*$"

-- Mirrors LIMITS in packages/protocol/src/limits.ts.
Path.MAX_DEPTH = 32
Path.MAX_SEGMENT_LENGTH = 100

-- Mirrors SERVICE_ROOTS in packages/protocol/src/path.ts.
local SERVICE_ROOTS = table.freeze({
	Workspace = true,
	ServerScriptService = true,
	ServerStorage = true,
	ReplicatedStorage = true,
	ReplicatedFirst = true,
	StarterGui = true,
	StarterPack = true,
	StarterPlayer = true,
	Lighting = true,
	SoundService = true,
	Teams = true,
	Chat = true,
	TextChatService = true,
})

--[[
	`string.split` is a Roblox extension and is not guaranteed outside Studio,
	where these modules are unit-tested. Hand-rolled so the same code runs in both.
]]
function Path.split(value: string): { string }
	local parts: { string } = {}
	local start = 1
	while true do
		local index = string.find(value, ".", start, true)
		if not index then
			table.insert(parts, string.sub(value, start))
			break
		end
		table.insert(parts, string.sub(value, start, index - 1))
		start = index + 1
	end
	return parts
end

--[[
	Validate a path and return its segments. Returns (segments, nil) or (nil, error).
]]
function Path.validate(path: any): ({ string }?, string?)
	if type(path) ~= "string" or path == "" then
		return nil, "path must be a non-empty string"
	end

	local segments = Path.split(path)
	if #segments > Path.MAX_DEPTH then
		return nil, string.format("path exceeds max depth %d", Path.MAX_DEPTH)
	end

	for _, segment in segments do
		if segment == "" then
			return nil, string.format('path "%s" has an empty segment', path)
		end
		if #segment > Path.MAX_SEGMENT_LENGTH then
			return nil,
				string.format(
					'path segment "%s…" exceeds %d characters',
					string.sub(segment, 1, 20),
					Path.MAX_SEGMENT_LENGTH
				)
		end
		if not string.match(segment, SEGMENT) then
			return nil, string.format('path segment "%s" is not a safe identifier', segment)
		end
	end

	if not SERVICE_ROOTS[segments[1]] then
		return nil, string.format('"%s" is not an addressable service root', segments[1])
	end

	return segments, nil
end

function Path.isServiceRoot(name: string): boolean
	return SERVICE_ROOTS[name] == true
end

--- The parent path, or nil for a service root.
function Path.parent(path: string): string?
	local segments = Path.split(path)
	if #segments <= 1 then
		return nil
	end
	table.remove(segments)
	return table.concat(segments, ".")
end

--- The final segment — the instance's own name.
function Path.name(path: string): string
	local segments = Path.split(path)
	return segments[#segments]
end

--[[
	True when `path` is `prefix` or lies beneath it.

	Segment-aware on purpose: a naive prefix match reports
	"ServerScriptService.ShopAdmin" as being inside "ServerScriptService.Shop",
	which is exactly the bug that turns an auto-apply scope into a hole.
]]
function Path.isWithin(path: string, prefix: string): boolean
	if path == prefix then
		return true
	end
	local p = Path.split(prefix)
	local c = Path.split(path)
	if #c <= #p then
		return false
	end
	for index, segment in p do
		if c[index] ~= segment then
			return false
		end
	end
	return true
end

--[[
	Resolve a full path to an existing instance.

	Returns (instance, nil) or (nil, error). A missing ancestor is an error that
	names both the missing segment and the prefix that did resolve, because
	"ServerScriptService.Shop is missing" is actionable and "not found" is not.
]]
function Path.resolve(root: any, path: any): (any?, string?)
	local segments, err = Path.validate(path)
	if not segments then
		return nil, err
	end

	local ok, service = pcall(function()
		return root:GetService(segments[1])
	end)
	if not ok or service == nil then
		return nil, string.format('service "%s" is not available in this place', segments[1])
	end

	local current = service
	for index = 2, #segments do
		local child = current:FindFirstChild(segments[index])
		if child == nil then
			return nil,
				string.format(
					'"%s" does not exist (resolved as far as "%s")',
					table.concat(segments, ".", 1, index),
					table.concat(segments, ".", 1, index - 1)
				)
		end
		current = child
	end

	return current, nil
end

--[[
	Resolve the *parent* of a path, for operations that create the leaf.

	Returns (parent, name, nil) or (nil, nil, error). The leaf is explicitly not
	required to exist; every ancestor is.
]]
function Path.resolveParent(root: any, path: any): (any?, string?, string?)
	local segments, err = Path.validate(path)
	if not segments then
		return nil, nil, err
	end
	if #segments == 1 then
		return nil, nil, string.format('"%s" is a service root and cannot be created or moved', path)
	end

	local name = segments[#segments]
	local parentPath = table.concat(segments, ".", 1, #segments - 1)
	local parent, resolveErr = Path.resolve(root, parentPath)
	if not parent then
		return nil, nil, resolveErr
	end
	return parent, name, nil
end

--[[
	The path of an existing instance, walked back up to its service root.
	Returns nil when the instance is not under an addressable root — which is the
	honest answer for something parented to nil or to an unaddressable service.
]]
function Path.of(instance: any): string?
	local segments: { string } = {}
	local current = instance
	while current ~= nil do
		local name = current.Name
		if type(name) ~= "string" then
			return nil
		end
		if SERVICE_ROOTS[name] then
			table.insert(segments, 1, name)
			return table.concat(segments, ".")
		end
		table.insert(segments, 1, name)
		if #segments > Path.MAX_DEPTH then
			return nil
		end
		current = current.Parent
	end
	return nil
end

return Path
