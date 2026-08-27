--!strict
--[[
	Rollback — replaying the inverses a journal captured, and saying honestly how
	far it got.

	`Journal.luau` captures an inverse before every operation runs; `Apply.luau`
	refuses any operation whose inverse it could not capture. This file is the
	other end of that: it takes the inverses back off the wire and puts the tree
	where they say it was. ADR-012 calls the journal the real safety net —
	validation and approval reduce how often it is needed, they never remove the
	need — so this is the part that has to be right when everything upstream was
	wrong.

	Four rules, in the order they matter:

	  1. **Refuse the whole reversal before touching anything, or attempt all of
	     it.** Every whole-delivery check below (the version, the ordering, the
	     undo waypoint) happens before the first inverse is replayed. A reversal
	     that discovers a reason to stop halfway has already half-restored the
	     tree, which is the one state neither the user nor the journal describes.

	  2. **A failed inverse does not stop the ones after it**, and this is the one
	     place that deliberately differs from `Apply:execute`. An apply stops at
	     the first failure because its operations build on each other, so pushing
	     on constructs more of a structure nobody asked for. A rollback is
	     removing a change nobody wants: each inverse is independently addressed
	     at a path, and stopping early leaves more of the unwanted change in the
	     place, not less. So every inverse is attempted and every failure is
	     reported.

	  3. **A partial reversal is never rounded up.** It gets its own version (see
	     `versionAfter` below) and its own outcomes, because the tree is then in a
	     state neither side has a record of and the inverses that would have
	     finished the job are spent. `rollbackStatusOf` in
	     `packages/protocol/src/apply.ts` is what reads these outcomes, and it
	     treats an empty outcome list as `failed` rather than as success.

	  4. **The order arrives decided.** The daemon reverses the list at dispatch
	     (`planRollback` in `packages/daemon/src/rollback.ts`) so the rule — undo
	     the last operation first — has one implementation rather than one per
	     consumer. This file checks that the order it received really is that
	     order and refuses otherwise; it never re-sorts, because a consumer that
	     silently corrected a delivery would hide a daemon that had stopped
	     ordering them.

	Dependencies arrive through `Rollback.new` for the reason every other module
	here injects them: Roblox's Instance-based `require` would otherwise make this
	untestable outside Studio, and the load-bearing test of the whole mechanism —
	apply a ChangeSet, reverse it, assert the tree is exactly what it was — runs in
	a plain Luau runtime.
]]

local Rollback = {}
Rollback.__index = Rollback

export type Dependencies = {
	--[[
		The applier, and not a second copy of what it holds.

		It owns the tree version, and two owners of that number is the defect this
		avoids: a rollback that moved its own copy would leave the next ChangeSet's
		`baseVersion` check comparing against a version the applier had never heard
		of. It also already holds the resolvers, the value codec, the journal module
		and the constructors, all wired the same way the apply path wires them —
		which matters, because an inverse has to be replayed by exactly the code
		that captured it.
	]]
	applier: any,
	--[[
		The counterpart of the `encodeJson` the journal serialised a deleted subtree
		with. `restoreSubtree` carries that blob and nothing else can read it: the
		daemon deliberately stores it opaquely, so if this cannot parse it the
		subtree is unrecoverable and the operation must fail loudly rather than
		restore an empty shell.
	]]
	decodeJson: (string) -> any,
}

function Rollback.new(deps: Dependencies)
	return setmetatable({
		applier = deps.applier,
		decodeJson = deps.decodeJson,
	}, Rollback)
end

local function assign(instance: any, property: string, value: any): (boolean, string?)
	local ok, err = pcall(function()
		(instance :: any)[property] = value
	end)
	if ok then
		return true, nil
	end
	-- The protocol asks for plain language and no Luau stack traces, so the
	-- "file:line:" prefix pcall hands back is stripped, exactly as `Apply` does.
	local message = tostring(err)
	return false, string.match(message, ":%d+:%s*(.+)$") or message
end

-- ── the five inverses ─────────────────────────────────────────────────────────
--
-- One per member of `InverseOperation` in `packages/protocol/src/apply.ts`, and
-- the union is closed: an inverse this file does not recognise is an error, never
-- a no-op. A no-op would report `ok` for an inverse that was never replayed,
-- which is the shape of "I do not understand this" and "this is safe" being the
-- same answer.

function Rollback:_deleteCreated(inverse: any): (boolean, string?)
	local applier = self.applier
	local target, err = applier.path.resolve(applier.root, inverse.path)
	if not target then
		-- Not treated as "already undone". Something else may have taken the path
		-- since, and destroying whatever is sitting there now would be this plugin
		-- deleting work nobody asked it to touch. The honest report is that the
		-- instance the journal created is not where the journal says it is.
		return false, string.format('nothing to remove at "%s": %s', inverse.path, tostring(err))
	end
	local ok, destroyErr = pcall(function()
		target:Destroy()
	end)
	if not ok then
		return false, string.format('"%s" could not be destroyed: %s', inverse.path, tostring(destroyErr))
	end
	return true, nil
end

function Rollback:_restoreProperty(inverse: any): (boolean, string?)
	local applier = self.applier
	local target, err = applier.path.resolve(applier.root, inverse.path)
	if not target then
		return false, err
	end
	local decodeOk, decoded = applier.value.decode(inverse.previous, applier.constructors)
	if not decodeOk then
		-- The journal recorded a value this build cannot decode. Writing something
		-- approximate would be worse than failing: the point of the record is that
		-- the property goes back to what it was, not near it.
		return false,
			string.format(
				'the journalled previous value of %s.%s cannot be read back: %s',
				inverse.path,
				tostring(inverse.property),
				tostring(decoded)
			)
	end
	local assigned, assignErr = assign(target, inverse.property, decoded)
	if not assigned then
		return false, string.format("%s.%s could not be restored: %s", inverse.path, tostring(inverse.property), tostring(assignErr))
	end
	return true, nil
end

function Rollback:_restoreSource(inverse: any): (boolean, string?)
	local applier = self.applier
	local target, err = applier.path.resolve(applier.root, inverse.path)
	if not target then
		return false, err
	end
	if type(inverse.previousSource) ~= "string" then
		return false, string.format('the journalled previous source of "%s" is not a string', inverse.path)
	end
	local assigned, assignErr = assign(target, "Source", inverse.previousSource)
	if not assigned then
		return false, string.format('%s source could not be restored: %s', inverse.path, tostring(assignErr))
	end
	return true, nil
end

--[[
	Move an instance back where it came from.

	The reading of the two fields is the one `packages/daemon/src/rollback.ts`
	pins and `Journal.capture` writes: `path` is where the instance is NOW (the
	move's destination) and `from` is where it goes BACK to. Read the other way
	round, a rollback silently misplaces instances instead of erroring — which is
	the failure a journal exists to make impossible — so the resolution failure
	below is left to speak for itself rather than being papered over with a
	fallback lookup at the other end.
]]
function Rollback:_moveBack(inverse: any): (boolean, string?)
	local applier = self.applier
	local target, err = applier.path.resolve(applier.root, inverse.path)
	if not target then
		return false, string.format('nothing to move back from "%s": %s', inverse.path, tostring(err))
	end
	local destination, name, destinationErr = applier.path.resolveParent(applier.root, inverse.from)
	if not destination then
		return false, destinationErr
	end

	local occupant = destination:FindFirstChild(name)
	if occupant ~= nil and occupant ~= target then
		return false, string.format('"%s" is occupied, so the move cannot be undone without overwriting it', inverse.from)
	end

	-- Parent before Name, as the forward move does: renaming first can create a
	-- transient duplicate that a later inverse in this same replay would resolve
	-- to.
	local parentOk, parentErr = assign(target, "Parent", destination)
	if not parentOk then
		return false, string.format('"%s" could not be moved back: %s', inverse.path, tostring(parentErr))
	end
	if target.Name ~= name then
		local nameOk, nameErr = assign(target, "Name", name)
		if not nameOk then
			-- Reported as a failure even though the reparent landed, and the message
			-- says exactly where the instance is now. "Half moved back" is not
			-- "moved back", and a caller told otherwise would stop looking.
			return false,
				string.format(
					'"%s" was moved back to its old parent but could not be renamed to "%s": %s — it is under the right parent with the wrong name',
					inverse.path,
					tostring(name),
					tostring(nameErr)
				)
		end
	end
	return true, nil
end

--[[
	Rebuild a deleted subtree from the serialised blob.

	The case the whole mechanism is judged on, and the one where a half-restore is
	unrecoverable: after a Destroy there is nothing left to read, so this blob is
	the only record that the subtree ever existed. Note what it is not — a
	byte-for-byte restore. Luau has no property reflection, so `describeSubtree`
	captures structure, names, attributes, tags, script sources and a fixed list of
	engine properties (`CAPTURED_PROPERTIES` in `Journal.luau`) and nothing else.
	M11 closed the part that was missing on the wire; that fidelity limit is a
	different gap and is marked `TODO(M15)` where the capture list lives. It is
	pinned in both directions by `plugin/tests/RollbackSpec.luau`, and
	`plugin/README.md` states it plainly rather than letting the word "rollback"
	imply more than the record holds.
]]
function Rollback:_restoreSubtree(inverse: any): (boolean, string?)
	local applier = self.applier
	local parent, err = applier.path.resolve(applier.root, inverse.parentPath)
	if not parent then
		return false, string.format('"%s" is gone, so the subtree it held cannot be put back: %s', inverse.parentPath, tostring(err))
	end
	if type(inverse.serialised) ~= "string" then
		return false, string.format('the journalled subtree for "%s" is not a serialised string', inverse.parentPath)
	end

	local parseOk, node = pcall(self.decodeJson, inverse.serialised)
	if not parseOk or type(node) ~= "table" or type(node.name) ~= "string" then
		-- Fail loudly. A half-parsed blob would rebuild a shell with the right name
		-- and none of the contents, and the user would see the instance reappear
		-- and believe the rollback worked.
		return false, string.format('the journalled subtree for "%s" could not be read back', inverse.parentPath)
	end

	local occupant = parent:FindFirstChild(node.name)
	if occupant ~= nil then
		-- Refused rather than merged or replaced. Something took the name after the
		-- delete; overwriting it would destroy work this rollback was never asked
		-- to touch, and merging would leave a tree that is neither.
		return false,
			string.format('"%s.%s" already exists, so the deleted subtree cannot be restored without overwriting it', inverse.parentPath, node.name)
	end

	local restored, restoreErr = applier.journal.restoreSubtree(parent, node, applier:_journalOptions())
	if not restored then
		return false, string.format('the subtree under "%s" could not be rebuilt: %s', inverse.parentPath, tostring(restoreErr))
	end
	return true, nil
end

local REPLAYERS: { [string]: any } = {
	deleteCreated = Rollback._deleteCreated,
	restoreProperty = Rollback._restoreProperty,
	restoreSource = Rollback._restoreSource,
	moveBack = Rollback._moveBack,
	restoreSubtree = Rollback._restoreSubtree,
}

--[[
	Reasons to refuse the whole delivery, checked before anything is touched.

	Returning one reason is not a shortcut around per-inverse reporting: every
	step still gets an outcome, they simply all carry the same cause.
]]
function Rollback:_refusal(delivery: any): string?
	if type(delivery.steps) ~= "table" or #delivery.steps == 0 then
		-- An old daemon sends a rollback delivery carrying only the ids. Executing
		-- that as "nothing to do" would report a clean reversal for a tree nobody
		-- touched, which is the worst possible lie this file could tell.
		return "the daemon sent a rollback with no inverse operations, so there is nothing this plugin can reverse"
	end
	if type(delivery.restoresToVersion) ~= "number" then
		return "the rollback delivery does not say which version it restores to"
	end

	local version = self.applier:version()
	if version ~= nil and type(delivery.expectedVersion) == "number" and delivery.expectedVersion ~= version then
		return string.format(
			"this rollback expects tree version %d but the place is at %d — the tree moved after the reversal was dispatched",
			delivery.expectedVersion,
			version
		)
	end

	--[[
		The order has to be the one the daemon decided: strictly decreasing indices
		into the journal's `inverses`, because the last operation applied is the
		first one undone. Checked rather than re-sorted — a consumer that quietly
		corrected the order would mask a daemon that had stopped producing it, and
		the very next rollback of a create-then-set pair would delete the instance
		before restoring a property on it.
	]]
	local previous: number? = nil
	for _, step in delivery.steps do
		if type(step) ~= "table" or type(step.index) ~= "number" or type(step.inverse) ~= "table" then
			return "the rollback delivery carries a step this plugin cannot read"
		end
		if previous ~= nil and step.index >= previous then
			return string.format(
				"the rollback delivery replays inverse %d after inverse %d; inverses are undone last-first",
				step.index,
				previous
			)
		end
		previous = step.index
	end
	return nil
end

function Rollback:_refusedResult(delivery: any, reason: string): any
	local outcomes = {}
	local steps = if type(delivery.steps) == "table" then delivery.steps else {}
	for _, step in steps do
		local index = if type(step) == "table" and type(step.index) == "number" then step.index else 0
		table.insert(outcomes, { index = index, ok = false, error = reason })
	end
	if #outcomes == 0 then
		-- A result with no outcomes reads as `failed` (`rollbackStatusOf`), which is
		-- correct, but it says nothing about why. One outcome carrying the reason is
		-- what a person actually needs, and index 0 is the only index a delivery
		-- with no readable steps can honestly name.
		table.insert(outcomes, { index = 0, ok = false, error = reason })
	end
	return {
		journalId = delivery.journalId,
		changeSetId = delivery.changeSetId,
		outcomes = outcomes,
		-- Nothing was touched, so the tree has not moved.
		newVersion = self.applier:version() or delivery.expectedVersion or 0,
		rolledBackAt = self.applier.now(),
		pluginVersion = self.applier.pluginVersion,
	}
end

--[[
	Replay a rollback delivery.

	Returns (rollbackResult, notes) — the result is exactly the protocol's
	`RollbackResult` and is what gets posted; `notes` are lines for the console
	that have nowhere to live on the wire.
]]
function Rollback:execute(delivery: any): (any, { string })
	local notes: { string } = {}

	local refusal = self:_refusal(delivery)
	if refusal then
		return self:_refusedResult(delivery, refusal), notes
	end

	local applier = self.applier
	local recordingId: any = nil
	if applier.changeHistory then
		-- The person sitting in Studio should be able to Ctrl+Z a rollback exactly
		-- as they can an apply. And, as in `Apply:execute`, a reversal Studio will
		-- not open a waypoint for is refused outright rather than performed with no
		-- undo of its own: the inverses are spent once replayed, so a rollback with
		-- no waypoint has no recovery path in either direction.
		local ok, id = pcall(function()
			return applier.changeHistory:TryBeginRecording("ForgeBridge rollback", string.format("rollback of %s", tostring(delivery.changeSetId)))
		end)
		recordingId = if ok then id else nil
		if recordingId == nil then
			return self:_refusedResult(
				delivery,
				"Studio would not open an undo waypoint for this rollback — another recording is already in progress, so nothing was reversed; try again once it finishes"
			),
				notes
		end
	end

	local outcomes = {}
	local reversed = 0
	for _, step in delivery.steps do
		local replayer = REPLAYERS[step.inverse.inverse]
		if not replayer then
			table.insert(outcomes, {
				index = step.index,
				ok = false,
				error = string.format('this plugin does not understand the inverse "%s"', tostring(step.inverse.inverse)),
			})
			continue
		end
		local ok, err = replayer(self, step.inverse)
		if ok then
			reversed += 1
			table.insert(outcomes, { index = step.index, ok = true })
		else
			table.insert(outcomes, { index = step.index, ok = false, error = err or "the inverse could not be replayed" })
		end
	end

	if recordingId ~= nil and applier.changeHistory then
		pcall(function()
			local operation = if reversed > 0
				then Enum.FinishRecordingOperation.Commit
				else Enum.FinishRecordingOperation.Cancel
			applier.changeHistory:FinishRecording(recordingId, operation)
		end)
	end

	--[[
		Which version the tree is at now, and the three answers are genuinely
		different:

		  * everything reversed — the tree is where it was before the apply, so it
		    is at `restoresToVersion`, the version the daemon computed from the
		    journal's own bracket;
		  * nothing reversed — nothing moved, so the version does not move either;
		  * some reversed — and this is the case that must not borrow either
		    neighbour's answer. The tree is now in a state no recorded version
		    describes: not the post-apply state, not the pre-apply one. Reporting
		    `restoresToVersion` would tell the next ChangeSet it was building
		    against a tree that exists nowhere. So it takes a fresh version above
		    the one it started from, which is what makes the next `baseVersion`
		    check fail loudly instead of passing against a fiction.
	]]
	local before = applier:version() or delivery.expectedVersion or 0
	local versionAfter: number
	-- `reversed > 0` first, and not because it can be false here — `_refusal`
	-- guarantees at least one step, so an empty outcome list is unreachable. It is
	-- first because `0 == 0` is the shape that would claim the tree went back to
	-- `restoresToVersion` having touched nothing, and a branch that only reads
	-- correctly while an invariant elsewhere holds is one that stops reading
	-- correctly the moment that invariant moves.
	if reversed > 0 and reversed == #outcomes then
		versionAfter = delivery.restoresToVersion
	elseif reversed == 0 then
		versionAfter = before
	else
		versionAfter = before + 1
		table.insert(
			notes,
			string.format(
				"%d of %d inverse operations were replayed — the place is in a state neither this rollback nor the original apply describes, and the remaining inverses are spent",
				reversed,
				#outcomes
			)
		)
	end
	applier:setVersion(versionAfter)

	return {
		journalId = delivery.journalId,
		changeSetId = delivery.changeSetId,
		outcomes = outcomes,
		newVersion = versionAfter,
		rolledBackAt = applier.now(),
		pluginVersion = applier.pluginVersion,
	},
		notes
end

--- True only when every inverse replayed. Mirrors `rollbackStatusOf` in the protocol.
function Rollback.isFullyReversed(result: any): boolean
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

--- "2 of 3 inverse operations replayed" — the one line that goes in the console.
function Rollback.summarise(result: any): string
	local reversed = 0
	for _, outcome in result.outcomes do
		if outcome.ok then
			reversed += 1
		end
	end
	return string.format("%d of %d inverse operations replayed", reversed, #result.outcomes)
end

return Rollback
