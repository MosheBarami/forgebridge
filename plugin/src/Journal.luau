--!strict
--[[
	Journal — capturing the inverse of an operation BEFORE it runs.

	This is the load-bearing safety mechanism of the whole system (ADR-012).
	Validation reduces how often it is needed; it never removes the need. Two
	rules follow from that and are enforced here rather than in the caller:

	  1. capture happens before the operation, never after. After a Destroy there
	     is nothing left to read;
	  2. a capture that fails is a hard stop for that operation. Applying something
	     the plugin cannot reverse is exactly the outcome the journal exists to
	     prevent, so Apply refuses the operation rather than proceeding blind.

	The shapes produced here match InverseOperation in
	packages/protocol/src/apply.ts exactly — deleteCreated, restoreProperty,
	restoreSource, moveBack, restoreSubtree.

	Dependencies arrive through `options` so this module can be unit-tested with
	plain tables standing in for Instances.
]]

local Journal = {}

--[[
	Properties worth capturing when a subtree is destroyed.

	Luau has no property reflection: there is no `instance:GetProperties()`, so a
	full-fidelity serialisation is not something this file can honestly claim.
	Every read below is guarded, and a property a class does not have is simply
	skipped. Structure, names, attributes, tags and script sources are always
	captured; engine properties are captured only if they are on this list.

	TODO(M11): full-fidelity restore ("rollback restores the prior tree
	byte-for-byte") needs a property table generated from a Roblox API dump and
	shipped with the plugin. Until then a durable restore of a delete rebuilds the
	tree and these properties, and the README says so plainly.
	Owner: plugin (this file) + packages/core journal.
]]
local CAPTURED_PROPERTIES = table.freeze({
	-- BasePart
	"Anchored", "CanCollide", "CanTouch", "CastShadow", "CFrame", "Color", "Material",
	"Reflectance", "Size", "Transparency",
	-- Model
	"WorldPivot",
	-- GuiObject
	"AnchorPoint", "BackgroundColor3", "BackgroundTransparency", "BorderSizePixel",
	"Position", "Visible", "ZIndex",
	-- Text and image widgets
	"Image", "ImageColor3", "RichText", "ScaleType", "Text", "TextColor3", "TextScaled",
	"TextSize", "TextWrapped",
	-- Scripts
	"Disabled", "Enabled", "RunContext",
	-- Sound
	"Looped", "PlaybackSpeed", "SoundId", "Volume",
	-- Value objects
	"Value",
})

local function readProperty(instance: any, name: string): (boolean, any)
	return pcall(function()
		return (instance :: any)[name]
	end)
end

--[[
	Describe a subtree as plain data.

	Deliberately the plugin's own format and opaque to the server (see the note on
	restoreSubtree in packages/protocol/src/apply.ts): the server has no business
	understanding Roblox instances, and changing this shape must not require a
	server release.
]]
function Journal.describeSubtree(instance: any, options: any?): any
	local opts: any = options or {}
	local encodeValue = opts.encodeValue

	local node: any = {
		className = instance.ClassName,
		name = instance.Name,
		properties = {},
		attributes = {},
		children = {},
	}

	if encodeValue then
		for _, property in CAPTURED_PROPERTIES do
			local readOk, current = readProperty(instance, property)
			if readOk then
				local encodeOk, encoded = encodeValue(current, opts)
				if encodeOk then
					node.properties[property] = encoded
				end
			end
		end
	end

	local attributesOk, attributes = pcall(function()
		return instance:GetAttributes()
	end)
	if attributesOk and type(attributes) == "table" and encodeValue then
		for key, value in attributes do
			local encodeOk, encoded = encodeValue(value, opts)
			if encodeOk then
				node.attributes[key] = encoded
			end
		end
	end

	local collectionService = opts.collectionService
	if collectionService then
		local tagsOk, tags = pcall(function()
			return collectionService:GetTags(instance)
		end)
		if tagsOk and type(tags) == "table" and #tags > 0 then
			node.tags = tags
		end
	end

	local sourceOk, source = readProperty(instance, "Source")
	if sourceOk and type(source) == "string" then
		node.source = source
	end

	local childrenOk, children = pcall(function()
		return instance:GetChildren()
	end)
	if childrenOk and type(children) == "table" then
		for _, child in children do
			table.insert(node.children, Journal.describeSubtree(child, opts))
		end
	end

	return node
end

--- Count instances in a described subtree — the "what you lose" number in a diff.
function Journal.countNodes(node: any): number
	local total = 1
	for _, child in node.children or {} do
		total += Journal.countNodes(child)
	end
	return total
end

--[[
	Rebuild a subtree from `Journal.describeSubtree` output under `parent`.

	Used by the session-scoped undo; a rollback that arrives from the core comes
	back as an ordinary ChangeSet and goes through Apply like anything else.
]]
function Journal.restoreSubtree(parent: any, node: any, options: any?): (any?, string?)
	local opts: any = options or {}
	local instanceNew = opts.instanceNew or Instance.new
	local decodeValue = opts.decodeValue

	local ok, instance = pcall(instanceNew, node.className)
	if not ok or instance == nil then
		return nil, string.format('cannot recreate a "%s": %s', tostring(node.className), tostring(instance))
	end
	instance.Name = node.name

	if decodeValue then
		for property, encoded in node.properties or {} do
			local decodeOk, decoded = decodeValue(encoded, opts.constructors)
			if decodeOk then
				pcall(function()
					(instance :: any)[property] = decoded
				end)
			end
		end
		for key, encoded in node.attributes or {} do
			local decodeOk, decoded = decodeValue(encoded, opts.constructors)
			if decodeOk then
				pcall(function()
					instance:SetAttribute(key, decoded)
				end)
			end
		end
	end

	if node.source ~= nil then
		pcall(function()
			(instance :: any).Source = node.source
		end)
	end

	local collectionService = opts.collectionService
	if collectionService and node.tags then
		for _, tag in node.tags do
			pcall(function()
				collectionService:AddTag(instance, tag)
			end)
		end
	end

	for _, child in node.children or {} do
		Journal.restoreSubtree(instance, child, opts)
	end

	instance.Parent = parent
	return instance, nil
end

--[[
	Capture the inverse of one operation.

	`target` is the already-resolved instance the operation addresses, or nil when
	it does not exist yet (a create, or a writeScript that will create). Returns
	(capture, nil) or (nil, error), where capture is:

	    { inverse = <InverseOperation>, clone = <Instance?>, note = <string?> }

	`clone` is present only for deletes: it is a live, full-fidelity copy held for
	the session so an immediate undo loses nothing, while `inverse.serialised`
	is the durable but reduced-fidelity record.
]]
function Journal.capture(operation: any, target: any, options: any?): (any?, string?)
	local opts: any = options or {}
	local kind = operation.op

	if kind == "createInstance" then
		return { inverse = { inverse = "deleteCreated", path = operation.path } }, nil
	elseif kind == "setProperty" then
		--[[
			`restoreProperty` is keyed on `operation.path`, and that is now safe to
			rely on: the operation cannot be one that invalidates its own path.
			`SetPropertyOp` refuses `Parent` and `Name` (STRUCTURAL_PROPERTIES in
			packages/protocol/src/operation.ts) and `Apply:_setProperty` refuses them
			again on arrival, so the instance this inverse points at is still at that
			path after the operation runs. Nothing here has to detect or special-case
			a rename that would leave the inverse pointing at nothing — but if either
			of those two gates ever moves, this is what was resting on them.
		]]
		if target == nil then
			return nil, string.format('cannot capture a previous value: "%s" does not exist', operation.path)
		end
		local encodeValue = opts.encodeValue
		if type(encodeValue) ~= "function" then
			return nil, "no value encoder was provided to the journal"
		end
		local readOk, current = readProperty(target, operation.property)
		if not readOk then
			return nil,
				string.format(
					'"%s" has no readable property "%s", so its previous value cannot be journaled',
					operation.path,
					tostring(operation.property)
				)
		end
		local encodeOk, encoded = encodeValue(current, opts)
		if not encodeOk then
			return nil,
				string.format(
					'the previous value of %s.%s cannot be journaled: %s',
					operation.path,
					tostring(operation.property),
					tostring(encoded)
				)
		end
		return {
			inverse = {
				inverse = "restoreProperty",
				path = operation.path,
				property = operation.property,
				previous = encoded,
			},
		},
			nil
	elseif kind == "writeScript" then
		-- A writeScript against a path that does not exist yet creates the script,
		-- so its inverse is a delete, not a source restore. Getting this backwards
		-- leaves an orphan script behind on every rollback.
		if target == nil then
			return { inverse = { inverse = "deleteCreated", path = operation.path } }, nil
		end
		local readOk, source = readProperty(target, "Source")
		if not readOk or type(source) ~= "string" then
			return nil,
				string.format('"%s" is a %s, which has no readable Source', operation.path, tostring(target.ClassName))
		end
		return {
			inverse = { inverse = "restoreSource", path = operation.path, previousSource = source },
		},
			nil
	elseif kind == "moveInstance" then
		if target == nil then
			return nil, string.format('cannot capture a move: "%s" does not exist', operation.path)
		end
		-- Read as "the instance now at `path` belongs back at `from`". After the
		-- move the instance lives at operation.to, so that is where a rollback has
		-- to look for it; `from` is where it came from and where it goes back.
		-- TODO(M11): pin this reading in the conformance test against the core's
		-- rollback executor — the union alone does not disambiguate it, and a
		-- wrong reading silently misplaces instances instead of erroring.
		-- Owner: packages/core rollback + plugin.
		return {
			inverse = { inverse = "moveBack", path = operation.to, from = operation.path },
		},
			nil
	elseif kind == "deleteInstance" then
		if target == nil then
			return nil, string.format('cannot capture a delete: "%s" does not exist', operation.path)
		end
		local parentPathOf = opts.parentPathOf
		if type(parentPathOf) ~= "function" then
			return nil, "no parent-path resolver was provided to the journal"
		end
		local parentPath = parentPathOf(operation.path)
		if type(parentPath) ~= "string" then
			return nil, string.format('"%s" is a service root and cannot be deleted', operation.path)
		end
		local encodeJson = opts.encodeJson
		if type(encodeJson) ~= "function" then
			return nil, "no serialiser was provided to the journal"
		end

		local described = Journal.describeSubtree(target, opts)
		local serialiseOk, serialised = pcall(encodeJson, described)
		if not serialiseOk or type(serialised) ~= "string" then
			return nil, string.format('the subtree under "%s" could not be serialised', operation.path)
		end

		-- Clone before Destroy. Archivable=false instances refuse to clone; that is
		-- worth recording rather than hiding, because it is the one case where the
		-- session undo is weaker than the durable record suggests.
		local cloneOk, clone = pcall(function()
			return target:Clone()
		end)
		local note: string? = nil
		if not cloneOk or clone == nil then
			clone = nil
			note = string.format(
				'"%s" could not be cloned (Archivable is probably false); undo will rebuild it from the journal instead',
				operation.path
			)
		end

		return {
			inverse = { inverse = "restoreSubtree", parentPath = parentPath, serialised = serialised },
			clone = clone,
			note = note,
			nodeCount = Journal.countNodes(described),
		},
			nil
	end

	return nil, string.format('unknown operation "%s"', tostring(kind))
end

--[[
	A session-scoped record of what this plugin applied.

	TODO(M11): ApplyResult carries a journalId but no inverse operations, and it
	has no metadata field to smuggle them through — "if a field is not in the Zod
	schema it does not exist". So the inverses computed here currently never reach
	the core, and rollback works only inside the Studio session that applied the
	change. Settling how inverses travel (an additive ApplyResult field or a
	dedicated endpoint) is protocol + core work.
	Owner: packages/protocol + packages/core journal.
]]
local Session = {}
Session.__index = Session

function Journal.newSession(limit: number?)
	return setmetatable({ _entries = {}, _limit = limit or 20 }, Session)
end

function Session:record(entry: any)
	table.insert(self._entries, entry)
	while #self._entries > self._limit do
		table.remove(self._entries, 1)
	end
end

function Session:latest(): any?
	return self._entries[#self._entries]
end

function Session:entries(): { any }
	return table.clone(self._entries)
end

return Journal
