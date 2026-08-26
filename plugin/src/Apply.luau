--!strict
--[[
	Apply — executing a ChangeSet against the place, in order, honestly.

	Three invariants, in the order they matter:

	  1. every operation captures its inverse BEFORE it runs, and an operation
	     whose inverse cannot be captured does not run at all. The journal is the
	     safety net (ADR-012); applying past it is how a bad run becomes permanent;
	  2. a partial apply is a legal outcome and is reported as one. Each operation
	     gets its own outcome and nothing is ever rounded up to success;
	  3. resolution is defensive. A missing ancestor, an occupied path, a class
	     mismatch and an unknown datatype are all errors — never a silent create,
	     overwrite or coercion.

	After the first failure the remaining operations are reported as not attempted
	rather than tried anyway: operations in a ChangeSet are ordered because they
	depend on each other, and pushing on past a failed create produces a cascade of
	confusing errors and a half-built structure nobody asked for.

	Dependencies are injected (`Apply.new`) rather than required, so the module can
	be unit-tested with fakes outside Studio — Roblox's Instance-based `require`
	leaves no other way to do it.
]]

local Apply = {}
Apply.__index = Apply

--[[
	Properties `setProperty` refuses, mirroring STRUCTURAL_PROPERTIES in
	`packages/protocol/src/operation.ts`.

	The schema already rejects both, so nothing well-formed reaches here — which
	is exactly why the check is repeated. The plugin is the last gate before the
	place, and it is the piece hardest to update in the field; an older daemon, a
	relay that rewrites a payload, or a producer speaking a stale schema could
	still put one on the wire. `Parent` is the dangerous one: assigning it
	relocates a whole subtree while the operation reports only its source path,
	so it escapes the policy allowlist, the bulk-delete counter and the
	auto-apply exclusion at the same time. `Name` invalidates the path every
	other operation and every journalled inverse is keyed on. `moveInstance`
	exists for both, reports both endpoints, and journals a resolvable inverse.
]]
local STRUCTURAL_PROPERTIES: { [string]: boolean } = table.freeze({ Parent = true, Name = true })

export type Dependencies = {
	root: any, -- the DataModel
	path: any, -- the Path module
	value: any, -- the Value module
	journal: any, -- the Journal module
	instanceNew: (string) -> any,
	encodeJson: (any) -> string,
	newId: () -> string,
	now: () -> string,
	pluginVersion: string,
	constructors: any?,
	changeHistory: any?,
	collectionService: any?,
	maxScriptBytes: number?,
	maxOperations: number?,
}

function Apply.new(deps: Dependencies)
	local self = setmetatable({
		root = deps.root,
		path = deps.path,
		value = deps.value,
		journal = deps.journal,
		instanceNew = deps.instanceNew,
		encodeJson = deps.encodeJson,
		newId = deps.newId,
		now = deps.now,
		pluginVersion = deps.pluginVersion,
		changeHistory = deps.changeHistory,
		collectionService = deps.collectionService,
		maxScriptBytes = deps.maxScriptBytes or 1048576,
		maxOperations = deps.maxOperations or 500,
		_version = nil :: number?,
	}, Apply)

	--[[
		InstanceRef values resolve through the same defensive path resolver as
		everything else, so a reference to something that does not exist is an
		error naming the path rather than a nil assignment.
	]]
	local constructors = table.clone(deps.constructors or self.value.RobloxConstructors)
	constructors.resolveRef = function(path: string)
		return self.path.resolve(self.root, path)
	end
	self.constructors = constructors

	return self
end

--- The tree version this plugin believes the place is at.
function Apply:version(): number?
	return self._version
end

function Apply:setVersion(version: number)
	self._version = version
end

function Apply:_journalOptions(): any
	return {
		encodeValue = self.value.encode,
		encodeJson = self.encodeJson,
		parentPathOf = self.path.parent,
		collectionService = self.collectionService,
		pathOf = self.path.of,
		instanceNew = self.instanceNew,
		decodeValue = self.value.decode,
		constructors = self.constructors,
	}
end

local function assign(instance: any, property: string, decoded: any): (boolean, string?)
	local ok, err = pcall(function()
		(instance :: any)[property] = decoded
	end)
	if ok then
		return true, nil
	end
	-- pcall hands back the whole "file:line: message" string. The protocol asks
	-- for plain language and no Luau stack traces, so keep only the message.
	local message = tostring(err)
	local stripped = string.match(message, ":%d+:%s*(.+)$")
	return false, stripped or message
end

function Apply:_create(operation: any): (any?, string?)
	local parent, name, err = self.path.resolveParent(self.root, operation.path)
	if not parent then
		return nil, err
	end
	if parent:FindFirstChild(name) ~= nil then
		return nil,
			string.format(
				'"%s" already exists — refusing to create a second instance at the same path',
				operation.path
			)
	end

	local properties = operation.properties or {}
	if properties.Parent ~= nil then
		return nil, "createInstance may not set Parent; the path decides where the instance goes"
	end
	if properties.Name ~= nil then
		local ok, decoded = self.value.decode(properties.Name, self.constructors)
		if not ok or decoded ~= name then
			return nil,
				string.format(
					'createInstance sets Name to %s but its path ends in "%s" — refusing to guess which is meant',
					self.value.describe(properties.Name),
					name
				)
		end
	end

	local capture, captureErr = self.journal.capture(operation, nil, self:_journalOptions())
	if not capture then
		return nil, captureErr
	end

	local okNew, instance = pcall(self.instanceNew, operation.className)
	if not okNew or instance == nil then
		return nil, string.format('"%s" is not a class this Studio version can create', tostring(operation.className))
	end

	-- Name and Parent are engine writes like any other and the engine can refuse
	-- either of them — a name a class rejects, a locked parent, a class Roblox
	-- will not accept as a child of that parent. Raw, an error here would unwind
	-- out of `execute` and take the poll loop with it, destroying the journal
	-- entry for everything the set had already applied and surfacing nothing to
	-- anyone. So they go through `assign` like every other mutation, and the
	-- half-built instance is destroyed rather than left orphaned.
	local nameOk, nameErr = assign(instance, "Name", name)
	if not nameOk then
		instance:Destroy()
		return nil, string.format('%s could not be named "%s": %s', operation.path, name, tostring(nameErr))
	end

	for property, encoded in properties do
		if property ~= "Name" then
			local decodeOk, decoded = self.value.decode(encoded, self.constructors)
			if not decodeOk then
				instance:Destroy()
				return nil, string.format("%s.%s: %s", operation.path, property, tostring(decoded))
			end
			local assignOk, assignErr = assign(instance, property, decoded)
			if not assignOk then
				instance:Destroy()
				return nil, string.format("%s.%s could not be set: %s", operation.path, property, tostring(assignErr))
			end
		end
	end

	-- Parent last: nothing watching the tree ever sees the instance half
	-- configured, and a property that fails to assign leaves nothing behind.
	local parentOk, parentErr = assign(instance, "Parent", parent)
	if not parentOk then
		instance:Destroy()
		return nil, string.format("%s could not be parented: %s", operation.path, tostring(parentErr))
	end
	return capture, nil
end

function Apply:_setProperty(operation: any): (any?, string?)
	if STRUCTURAL_PROPERTIES[tostring(operation.property)] then
		return nil,
			string.format(
				'setProperty may not write %s — use moveInstance to reparent or rename "%s"',
				tostring(operation.property),
				operation.path
			)
	end

	local target, err = self.path.resolve(self.root, operation.path)
	if not target then
		return nil, err
	end

	local decodeOk, decoded = self.value.decode(operation.value, self.constructors)
	if not decodeOk then
		return nil, string.format("%s.%s: %s", operation.path, tostring(operation.property), tostring(decoded))
	end

	local capture, captureErr = self.journal.capture(operation, target, self:_journalOptions())
	if not capture then
		return nil, captureErr
	end

	local assignOk, assignErr = assign(target, operation.property, decoded)
	if not assignOk then
		return nil, string.format("%s.%s could not be set: %s", operation.path, tostring(operation.property), tostring(assignErr))
	end
	return capture, nil
end

function Apply:_writeScript(operation: any): (any?, string?)
	local parent, name, err = self.path.resolveParent(self.root, operation.path)
	if not parent then
		return nil, err
	end
	if type(operation.source) ~= "string" then
		return nil, "writeScript needs a string source"
	end
	if #operation.source > self.maxScriptBytes then
		return nil, string.format("script source exceeds %d bytes", self.maxScriptBytes)
	end

	local existing = parent:FindFirstChild(name)
	if existing ~= nil and existing.ClassName ~= operation.scriptType then
		return nil,
			string.format(
				'"%s" is a %s but the operation declares a %s — refusing to replace it',
				operation.path,
				tostring(existing.ClassName),
				tostring(operation.scriptType)
			)
	end

	local capture, captureErr = self.journal.capture(operation, existing, self:_journalOptions())
	if not capture then
		return nil, captureErr
	end

	local target = existing
	if target == nil then
		local okNew, created = pcall(self.instanceNew, operation.scriptType)
		if not okNew or created == nil then
			return nil, string.format('"%s" is not a script class', tostring(operation.scriptType))
		end
		-- Through assign, like every other engine write in this module. A raw
		-- `created.Name = name` here would throw straight out of execute, taking
		-- the journal entry and the poll loop with it -- the same defect that was
		-- fixed in _create, and it survived here because a fresh, unparented
		-- instance looks harmless. It is not: Name can still be refused.
		local nameOk, nameErr = assign(created, "Name", name)
		if not nameOk then
			created:Destroy()
			return nil, string.format("%s could not be named: %s", operation.path, tostring(nameErr))
		end
		target = created
	end

	local setOk, setErr = assign(target, "Source", operation.source)
	if not setOk then
		if existing == nil then
			target:Destroy()
		end
		return nil, string.format("%s source could not be written: %s", operation.path, tostring(setErr))
	end

	if existing == nil then
		-- Parenting is the write most likely to be refused by the engine (a locked
		-- container, a class the parent will not accept). Unparented, `target` is
		-- invisible to the user and to any inverse, so on failure destroy it and
		-- report -- never leave an orphan the journal does not know about.
		local parentOk, parentErr = assign(target, "Parent", parent)
		if not parentOk then
			target:Destroy()
			return nil, string.format("%s could not be parented: %s", operation.path, tostring(parentErr))
		end
	end
	return capture, nil
end

--[[
	Move an instance, and be honest when only half of it lands.

	A move is two engine writes — reparent, then rename — and the second can fail
	after the first has already changed the tree. Returns the usual (capture, err)
	pair plus, in that one case, a third value: `{ inverse, note }` for
	`execute` to journal. "Partially applied, inverse recorded" is a different
	outcome from "not applied", and collapsing the two is how a mutation ends up
	in the place with its inverse thrown away.
]]
function Apply:_move(operation: any): (any?, string?, any?)
	local target, err = self.path.resolve(self.root, operation.path)
	if not target then
		return nil, err
	end
	local destination, newName, destinationErr = self.path.resolveParent(self.root, operation.to)
	if not destination then
		return nil, destinationErr
	end

	local occupant = destination:FindFirstChild(newName)
	if occupant ~= nil and occupant ~= target then
		return nil, string.format('"%s" is already taken', operation.to)
	end

	-- Roblox rejects a cycle with its own error, but "cannot set parent" tells the
	-- reviewer nothing about which two paths conflicted.
	local walker = destination
	while walker ~= nil do
		if walker == target then
			return nil, string.format('"%s" cannot be moved inside itself', operation.path)
		end
		walker = walker.Parent
	end

	local capture, captureErr = self.journal.capture(operation, target, self:_journalOptions())
	if not capture then
		return nil, captureErr
	end

	-- Parent before Name: renaming while the instance is still at its old parent
	-- can create a transient duplicate that a later operation in this same set
	-- would resolve to.
	local previousParent = target.Parent
	local parentOk, parentErr = assign(target, "Parent", destination)
	if not parentOk then
		return nil, string.format("%s could not be moved: %s", operation.path, tostring(parentErr))
	end
	if target.Name ~= newName then
		local nameOk, nameErr = assign(target, "Name", newName)
		if not nameOk then
			-- The reparent has already happened. Two things have to be true here,
			-- and the second matters more than the first:
			--
			--   1. put it back if the engine will let us, so the common case leaves
			--      the tree where the reviewer last saw it;
			--   2. journal the inverse either way. A restore that reports success is
			--      still only the engine's word for it, and an inverse that fails to
			--      resolve is a loud error a human can act on, while a mutation with
			--      no inverse at all is silent and permanent — which is the exact
			--      outcome the journal exists to prevent (ADR-012).
			local restoredOk = assign(target, "Parent", previousParent)
			local note = if restoredOk
				then string.format(
					'"%s" was moved but could not be renamed, and has been put back at its original parent; the journalled move-back for "%s" will not resolve',
					operation.path,
					operation.to
				)
				else string.format(
					'"%s" was moved but could not be renamed, and could not be put back — it is under the new parent with its old name, and the journal holds the move back',
					operation.path
				)
			return nil,
				string.format(
					'%s moved but could not be renamed to "%s": %s — %s',
					operation.path,
					tostring(newName),
					tostring(nameErr),
					if restoredOk then "it has been put back where it was" else "it is still at the new parent under its old name"
				),
				{ inverse = capture.inverse, note = note }
		end
	end
	return capture, nil
end

function Apply:_delete(operation: any): (any?, string?)
	local target, err = self.path.resolve(self.root, operation.path)
	if not target then
		return nil, err
	end

	local capture, captureErr = self.journal.capture(operation, target, self:_journalOptions())
	if not capture then
		return nil, captureErr
	end

	local ok, destroyErr = pcall(function()
		target:Destroy()
	end)
	if not ok then
		return nil, string.format("%s could not be destroyed: %s", operation.path, tostring(destroyErr))
	end
	return capture, nil
end

local EXECUTORS = {
	createInstance = Apply._create,
	setProperty = Apply._setProperty,
	writeScript = Apply._writeScript,
	moveInstance = Apply._move,
	deleteInstance = Apply._delete,
}

--[[
	Reasons to refuse the whole set before touching anything. Returning a single
	reason here is not a shortcut around per-operation reporting: every operation
	still gets an outcome, they simply all carry the same cause.
]]
function Apply:_refusal(changeSet: any): string?
	if type(changeSet.operations) ~= "table" or #changeSet.operations == 0 then
		return "the ChangeSet carries no operations"
	end
	if #changeSet.operations > self.maxOperations then
		return string.format("the ChangeSet carries %d operations, over the protocol limit of %d", #changeSet.operations, self.maxOperations)
	end
	if type(changeSet.baseVersion) ~= "number" then
		return "the ChangeSet has no baseVersion"
	end
	if self._version ~= nil and changeSet.baseVersion ~= self._version then
		return string.format(
			"this ChangeSet was built against tree version %d but the place is at %d — it must be rebased",
			changeSet.baseVersion,
			self._version
		)
	end
	return nil
end

--[[
	The result and journal entry for a set that was refused as a whole.

	One outcome per real operation, and none at all for an empty set: a phantom
	outcome would claim the plugin considered something it did not. Nothing was
	touched, so the version does not move.
]]
function Apply:_refusedResult(changeSet: any, reason: string, journalId: string, versionBefore: any): (any, any)
	local outcomes = {}
	local count = if type(changeSet.operations) == "table" then #changeSet.operations else 0
	for index = 1, count do
		table.insert(outcomes, { index = index - 1, ok = false, error = reason })
	end
	return {
		changeSetId = changeSet.id,
		outcomes = outcomes,
		newVersion = self._version or 0,
		journalId = journalId,
		appliedAt = self.now(),
		pluginVersion = self.pluginVersion,
	},
		{
			id = journalId,
			changeSetId = changeSet.id,
			summary = changeSet.summary,
			refused = reason,
			inverses = {},
			artefacts = {},
			notes = {},
			versionBefore = versionBefore,
			versionAfter = versionBefore,
		}
end

--[[
	Apply a ChangeSet.

	Returns (applyResult, journalEntry). The ApplyResult is exactly the protocol
	shape and is what gets posted; the journal entry carries the inverses and any
	live clones, which the frozen ApplyResult has no room for (see the TODO in
	Journal.luau).
]]
function Apply:execute(changeSet: any): (any, any)
	local outcomes = {}
	local inverses = {}
	local artefacts = {}
	local notes = {}
	local appliedOperations = {}

	local journalId = self.newId()
	local versionBefore = self._version or changeSet.baseVersion

	-- First contact: the plugin has no opinion about the tree version yet, so it
	-- adopts the producer's. Every later set is checked against what this plugin
	-- last reported, which is what makes stale sets detectable at all.
	if self._version == nil and type(changeSet.baseVersion) == "number" then
		self._version = changeSet.baseVersion
	end

	local refusal = self:_refusal(changeSet)
	if refusal then
		return self:_refusedResult(changeSet, refusal, journalId, versionBefore)
	end

	local recordingId: any = nil
	if self.changeHistory then
		-- Studio's own undo stack should be able to take the apply back too; the
		-- journal is for the producer, Ctrl+Z is for the person sitting there.
		local ok, id = pcall(function()
			return self.changeHistory:TryBeginRecording("ForgeBridge apply", changeSet.summary)
		end)
		recordingId = if ok then id else nil
		if recordingId == nil then
			-- TryBeginRecording answers nil when a recording is already open — another
			-- plugin's, or one of ours that never finished. Applying anyway would
			-- write into the place with no undo waypoint at all: Ctrl+Z would not
			-- reach it, nothing would say so, and the session journal would be the
			-- only way back from a set the user may never have read. Rollback is the
			-- load-bearing mechanism here (ADR-012), so a set that cannot be recorded
			-- is refused as a whole, exactly like a stale baseVersion. The cost is a
			-- retry once the other recording finishes; the alternative is an apply
			-- with no recovery path of any kind.
			return self:_refusedResult(
				changeSet,
				"Studio would not open an undo waypoint for this apply — another recording is already in progress, so nothing was applied; try again once it finishes",
				journalId,
				versionBefore
			)
		end
	end

	local failedAt: number? = nil
	for index, operation in changeSet.operations do
		-- The protocol indexes operations from zero (it is a TypeScript array);
		-- Luau counts from one. Convert at the boundary, once.
		local wireIndex = index - 1

		if failedAt ~= nil then
			table.insert(outcomes, {
				index = wireIndex,
				ok = false,
				error = string.format("not attempted: operation %d failed", failedAt - 1),
			})
			continue
		end

		local executor = EXECUTORS[operation.op]
		if not executor then
			failedAt = index
			table.insert(outcomes, {
				index = wireIndex,
				ok = false,
				error = string.format('this plugin does not understand the operation "%s"', tostring(operation.op)),
			})
			continue
		end

		local capture, err, partial = executor(self, operation)
		if capture then
			table.insert(outcomes, { index = wireIndex, ok = true })
			table.insert(inverses, capture.inverse)
			table.insert(appliedOperations, { index = wireIndex, operation = operation })
			if capture.clone ~= nil then
				artefacts[wireIndex] = capture.clone
			end
			if capture.note then
				table.insert(notes, capture.note)
			end
		else
			failedAt = index
			table.insert(outcomes, { index = wireIndex, ok = false, error = err or "the operation failed" })

			if partial then
				-- Partially applied, inverse recorded. `OperationOutcome` has room for
				-- `ok` and `error` and nothing else (packages/protocol/src/apply.ts),
				-- so the wire says "failed" and the error text says how far it got —
				-- but the journal must not: something changed in the place, so the
				-- inverse is recorded, the operation counts as applied (which is what
				-- moves the version and commits Studio's recording), and the note
				-- says what state it was left in.
				table.insert(inverses, partial.inverse)
				table.insert(appliedOperations, { index = wireIndex, operation = operation })
				if partial.note then
					table.insert(notes, partial.note)
				end
			end
		end
	end

	local appliedCount = #appliedOperations
	if recordingId ~= nil and self.changeHistory then
		pcall(function()
			local operation = if appliedCount > 0
				then Enum.FinishRecordingOperation.Commit
				else Enum.FinishRecordingOperation.Cancel
			self.changeHistory:FinishRecording(recordingId, operation)
		end)
	end

	-- The version only moves when the tree did. A set that applied nothing leaves
	-- the place exactly where the next ChangeSet expects to find it.
	local versionAfter = if appliedCount > 0 then versionBefore + 1 else versionBefore
	self._version = versionAfter

	local result = {
		changeSetId = changeSet.id,
		outcomes = outcomes,
		newVersion = versionAfter,
		journalId = journalId,
		appliedAt = self.now(),
		pluginVersion = self.pluginVersion,
	}

	local entry = {
		id = journalId,
		changeSetId = changeSet.id,
		summary = changeSet.summary,
		applied = appliedOperations,
		inverses = inverses,
		artefacts = artefacts,
		notes = notes,
		versionBefore = versionBefore,
		versionAfter = versionAfter,
		appliedAt = result.appliedAt,
	}

	return result, entry
end

--- True only when every operation applied. Mirrors isFullyApplied in the protocol.
function Apply.isFullyApplied(result: any): boolean
	if #result.outcomes == 0 then
		return false
	end
	for _, outcome in result.outcomes do
		if not outcome.ok then
			return false
		end
	end
	return true
end

--- "3 of 5 operations applied" — the one line that goes in the console.
function Apply.summarise(result: any): string
	local applied = 0
	for _, outcome in result.outcomes do
		if outcome.ok then
			applied += 1
		end
	end
	return string.format("%d of %d operations applied", applied, #result.outcomes)
end

return Apply
