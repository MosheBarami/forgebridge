--!nonstrict
--[[
	The load-bearing test of the whole system.

	ADR-012 does not promise an ordered list of inverse operations. It promises the
	tree comes back. So the first test here applies a ChangeSet that uses every
	operation the protocol has, replays the journal, and asserts that the place is
	byte-for-byte the structure it was before — not that the right inverses were
	listed in the right order, which is where a test of this mechanism is most
	tempting to stop.

	The `deleteInstance` in that set is the case the mechanism is judged on. After a
	Destroy there is nothing left to read, so the serialised subtree in the journal
	is the only record the instance ever existed, and a half-restore is
	unrecoverable — there is no second copy to try again from.

	What this file also pins is the limit of that restore, in
	`a property outside the captured list is not restored`. Luau has no property
	reflection, so `Journal.describeSubtree` captures structure, names, attributes,
	tags, script sources and a fixed list of engine properties and nothing else. A
	test suite that only demonstrated the happy path would leave the word
	"rollback" implying a fidelity the record does not hold.
]]
local Apply = require("../src/Apply")
local Journal = require("../src/Journal")
local Path = require("../src/Path")
local Rollback = require("../src/Rollback")
local Value = require("../src/Value")
local Fake = require("./Fake")

--- Enough of CollectionService for the journal to capture and restore tags.
local function fakeCollectionService()
	local tags = setmetatable({}, { __mode = "k" })
	return {
		GetTags = function(_, instance)
			return table.clone(tags[instance] or {})
		end,
		AddTag = function(_, instance, tag)
			local list = tags[instance] or {}
			table.insert(list, tag)
			tags[instance] = list
		end,
	}
end

local function newApplier(root, collectionService)
	local counter = 0
	return Apply.new({
		root = root,
		path = Path,
		value = Value,
		journal = Journal,
		instanceNew = function(className)
			return Fake.new(className, className, nil, true)
		end,
		encodeJson = Fake.encodeJson,
		newId = function()
			counter += 1
			return string.format("journal-%d", counter)
		end,
		now = function()
			return "2026-01-01T00:00:00Z"
		end,
		pluginVersion = "0.1.0-test",
		constructors = {},
		collectionService = collectionService,
	})
end

local function newRollback(applier)
	return Rollback.new({ applier = applier, decodeJson = Fake.decodeJson })
end

--[[
	Turn a journal entry into the delivery the daemon would send.

	Mirrors `planRollback` in `packages/daemon/src/rollback.ts`: `index` is the
	position in the journal's `inverses`, and the list is reversed so the last
	operation applied is the first one undone. Written out here rather than
	imported because this suite runs in a plain Luau runtime with no access to the
	TypeScript packages — the daemon's own tests pin the daemon's half, and the
	ordering rule this restates is the one `Rollback:_refusal` refuses to correct.
]]
local function deliveryFor(entry, overrides)
	local steps = {}
	for index = #entry.inverses, 1, -1 do
		table.insert(steps, { index = index - 1, inverse = entry.inverses[index] })
	end
	local delivery = {
		kind = "rollback",
		journalId = entry.id,
		changeSetId = entry.changeSetId,
		expectedVersion = entry.versionAfter,
		restoresToVersion = entry.versionBefore,
		steps = steps,
	}
	for key, value in overrides or {} do
		delivery[key] = value
	end
	return delivery
end

local function snapshot(root)
	return Fake.encodeJson(Fake.describe(root))
end

local function changeSet(operations, baseVersion)
	return {
		id = "33333333-3333-4333-8333-333333333333",
		baseVersion = baseVersion or 0,
		summary = "a set that touches everything",
		operations = operations,
	}
end

--[[
	A place with something in it worth losing.

	`Workspace.Shop.Sign` is the one that gets deleted: a Part carrying a captured
	property, an attribute and a tag, with a nested TextLabel of its own and a
	nested Script carrying source. Every one of those is a separate way a restore
	can quietly come back empty.
]]
local function place(collectionService)
	local root = Fake.dataModel({ "Workspace", "ServerScriptService", "ReplicatedStorage" })
	local workspace = root:GetService("Workspace")

	local shop = Fake.new("Model", "Shop")
	shop.Parent = workspace

	local counter = Fake.new("Part", "Counter", { Anchored = true, Transparency = 0 })
	counter.Parent = shop

	local sign = Fake.new("Part", "Sign", { Anchored = true, Transparency = 0.5 })
	sign:SetAttribute("Shopfront", "north")
	collectionService:AddTag(sign, "Interactable")
	sign.Parent = shop

	local label = Fake.new("TextLabel", "Label", { Text = "OPEN", TextScaled = true })
	label.Parent = sign

	local blink = Fake.new("Script", "Blink", { Disabled = false, Source = 'print("blink")' })
	blink.Parent = sign

	local spawnPoint = Fake.new("SpawnLocation", "Spawn", { Anchored = true })
	spawnPoint.Parent = workspace

	local purchase = Fake.new("Script", "Purchase", { Source = 'print("v1")' })
	purchase.Parent = root:GetService("ServerScriptService")

	return root
end

--[[
	Every operation kind, in an order where the ordering is load-bearing: the
	`setProperty` at index 1 writes to the instance the `createInstance` at index 0
	made, so a replay in application order would delete the instance and then try
	to restore a property on a path that is gone.
]]
local ROUND_TRIP = {
	{ op = "createInstance", path = "Workspace.Shop.Door", className = "Part", properties = { Anchored = { t = "Bool", v = true } } },
	{ op = "setProperty", path = "Workspace.Shop.Door", property = "Anchored", value = { t = "Bool", v = false } },
	{ op = "setProperty", path = "Workspace.Shop.Counter", property = "Transparency", value = { t = "Number", v = 0.75 } },
	{ op = "writeScript", path = "ServerScriptService.Purchase", scriptType = "Script", source = 'print("v2")' },
	{ op = "writeScript", path = "ServerScriptService.Refund", scriptType = "Script", source = 'print("new")' },
	{ op = "moveInstance", path = "Workspace.Spawn", to = "ReplicatedStorage.Spawn" },
	{ op = "deleteInstance", path = "Workspace.Shop.Sign" },
}

return function(t)
	t.suite("Rollback — the round trip")

	t.test("returns the tree to its exact prior state, every operation kind included", function()
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local before = snapshot(root)

		local result, entry = applier:execute(changeSet(ROUND_TRIP))
		t.truthy(Apply.isFullyApplied(result), "the fixture has to apply cleanly or it is testing nothing")
		t.equal(#entry.inverses, #ROUND_TRIP, "one inverse per operation, or the journal cannot be replayed")
		-- The fixture is checked against itself first. A round trip over a tree
		-- nothing changed passes for the wrong reason.
		t.truthy(snapshot(root) ~= before, "the apply has to have actually changed the place")

		local reversal, notes = newRollback(applier):execute(deliveryFor(entry))
		t.truthy(Rollback.isFullyReversed(reversal), Rollback.summarise(reversal))
		t.equal(#notes, 0, "a clean reversal has nothing to warn about")
		t.equal(snapshot(root), before, "ADR-012 promises the tree comes back, not that a list was ordered right")
		t.equal(reversal.newVersion, entry.versionBefore, "a full reversal lands on the version the apply started from")
		t.equal(applier:version(), entry.versionBefore, "the applier owns the version, and a rollback moves it")
	end)

	t.test("restores a deleted subtree from the serialised blob alone", function()
		-- The case with no second chance. The instance is destroyed, so the blob in
		-- the journal is the only record it ever existed — and the assertion is on
		-- the nested child and the script source inside it, because a restore that
		-- rebuilt the top of the subtree and nothing under it would still make the
		-- instance reappear in the explorer.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local before = snapshot(root)

		local _, entry = applier:execute(changeSet({ { op = "deleteInstance", path = "Workspace.Shop.Sign" } }))
		t.isNil(Path.resolve(root, "Workspace.Shop.Sign"), "the delete has to have happened")

		local reversal = newRollback(applier):execute(deliveryFor(entry))
		t.truthy(Rollback.isFullyReversed(reversal), Rollback.summarise(reversal))

		local sign = Path.resolve(root, "Workspace.Shop.Sign")
		t.truthy(sign, "the subtree came back")
		t.equal(sign.Transparency, 0.5, "a captured property came back with it")
		t.equal(sign:GetAttributes().Shopfront, "north")
		t.equal(collectionService:GetTags(sign)[1], "Interactable")
		t.equal(Path.resolve(root, "Workspace.Shop.Sign.Label").Text, "OPEN", "the nested child came back")
		t.equal(Path.resolve(root, "Workspace.Shop.Sign.Blink").Source, 'print("blink")', "and its source with it")
		t.equal(snapshot(root), before)
	end)

	t.test("replays last-first: application order would delete the instance a property is restored on", function()
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)

		local _, entry = applier:execute(changeSet({
			{ op = "createInstance", path = "Workspace.Shop.Door", className = "Part", properties = { Anchored = { t = "Bool", v = true } } },
			{ op = "setProperty", path = "Workspace.Shop.Door", property = "Anchored", value = { t = "Bool", v = false } },
		}))

		local delivery = deliveryFor(entry)
		t.equal(delivery.steps[1].index, 1, "the last operation applied is the first one undone")
		local reversal = newRollback(applier):execute(delivery)
		t.truthy(Rollback.isFullyReversed(reversal))
		t.isNil(Path.resolve(root, "Workspace.Shop.Door"))
	end)

	t.test("moveBack reads path as where it is now and from as where it goes back", function()
		-- The reading the union alone does not disambiguate. Read the other way
		-- round a rollback silently misplaces instances instead of erroring, which
		-- is the failure a journal exists to make impossible — so this asserts on
		-- where the instance ends up, not on what the inverse says.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)

		local _, entry = applier:execute(changeSet({
			{ op = "moveInstance", path = "Workspace.Spawn", to = "ReplicatedStorage.Spawn" },
		}))
		t.equal(entry.inverses[1].path, "ReplicatedStorage.Spawn")
		t.equal(entry.inverses[1].from, "Workspace.Spawn")

		t.truthy(Rollback.isFullyReversed(newRollback(applier):execute(deliveryFor(entry))))
		t.truthy(Path.resolve(root, "Workspace.Spawn"))
		t.isNil(Path.resolve(root, "ReplicatedStorage.Spawn"))
	end)

	t.suite("Rollback — the limits of the record")

	t.test("a property outside the captured list is not restored, and the suite says so", function()
		-- Luau has no property reflection, so a durable restore of a delete carries
		-- `CAPTURED_PROPERTIES` and nothing else (TODO(M15) in Journal.luau). This
		-- is the honest shape of that gap, pinned so the claim in plugin/README.md
		-- cannot quietly become false in either direction.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		-- One property on the captured list and one off it, on the same instance,
		-- so the two outcomes are told apart by the list and by nothing else.
		local kiosk = Fake.new("Part", "Kiosk", { Transparency = 0.5, CustomPhysicalProperties = "not-on-the-list" })
		kiosk.Parent = Path.resolve(root, "Workspace.Shop")

		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({ { op = "deleteInstance", path = "Workspace.Shop.Kiosk" } }))
		t.truthy(Rollback.isFullyReversed(newRollback(applier):execute(deliveryFor(entry))))

		local restored = Path.resolve(root, "Workspace.Shop.Kiosk")
		t.truthy(restored, "the subtree still comes back")
		t.equal(restored.Transparency, 0.5, "and everything on the captured list comes back with it")
		local ok = pcall(function()
			return restored.CustomPhysicalProperties
		end)
		t.falsy(ok, "a property off the list is simply not there — the record never held it")
	end)

	t.suite("Rollback — partial and refused")

	t.test("reports a partial reversal as partial and never rounds it up", function()
		-- The outcome worse than either neighbour: the tree is in a state neither
		-- the user nor the journal describes, and the inverses that would have
		-- finished the job are spent. A result that claimed a clean reversal here
		-- would be the one lie the mechanism cannot survive.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)

		local _, entry = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Shop.Counter", property = "Transparency", value = { t = "Number", v = 0.75 } },
			{ op = "setProperty", path = "Workspace.Shop.Sign", property = "Transparency", value = { t = "Number", v = 0.9 } },
		}))
		-- Something else removed the Sign between the apply and the reversal, which
		-- is exactly the kind of thing that happens in a real place.
		Path.resolve(root, "Workspace.Shop.Sign"):Destroy()

		local reversal, notes = newRollback(applier):execute(deliveryFor(entry))
		t.falsy(Rollback.isFullyReversed(reversal))
		t.equal(Rollback.summarise(reversal), "1 of 2 inverse operations replayed")
		t.equal(reversal.outcomes[1].ok, false, "the Sign's inverse is the one that could not be replayed")
		t.truthy(reversal.outcomes[1].error, "and it says why, in words")
		t.equal(reversal.outcomes[2].ok, true)
		t.equal(Path.resolve(root, "Workspace.Shop.Counter").Transparency, 0, "what could be reversed was")

		t.truthy(reversal.newVersion ~= entry.versionBefore, "a partial reversal must not claim the pre-apply version")
		t.equal(reversal.newVersion, entry.versionAfter + 1, "it takes a fresh version, because the tree is somewhere new")
		t.contains(notes[1], "neither this rollback nor the original apply describes")
	end)

	t.test("refuses the whole reversal before touching anything when the tree has moved", function()
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Shop.Counter", property = "Transparency", value = { t = "Number", v = 0.75 } },
		}))
		local afterApply = snapshot(root)

		local reversal = newRollback(applier):execute(deliveryFor(entry, { expectedVersion = entry.versionAfter + 7 }))
		t.falsy(Rollback.isFullyReversed(reversal))
		t.contains(reversal.outcomes[1].error, "the tree moved after the reversal was dispatched")
		t.equal(snapshot(root), afterApply, "a refused reversal leaves the place exactly as it found it")
		t.equal(reversal.newVersion, entry.versionAfter, "and leaves the version where it found it too")
	end)

	t.test("refuses a delivery whose steps are not in replay order rather than re-sorting them", function()
		-- A consumer that quietly corrected the order would mask a daemon that had
		-- stopped producing it, and the very next create-then-set pair would be
		-- deleted before its property was restored.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({
			{ op = "createInstance", path = "Workspace.Shop.Door", className = "Part", properties = { Anchored = { t = "Bool", v = true } } },
			{ op = "setProperty", path = "Workspace.Shop.Door", property = "Anchored", value = { t = "Bool", v = false } },
		}))

		local forwards = deliveryFor(entry)
		forwards.steps = { forwards.steps[2], forwards.steps[1] }
		local reversal = newRollback(applier):execute(forwards)
		t.falsy(Rollback.isFullyReversed(reversal))
		t.contains(reversal.outcomes[1].error, "inverses are undone last-first")
		t.truthy(Path.resolve(root, "Workspace.Shop.Door"), "nothing was touched")
	end)

	t.test("refuses a delivery carrying no inverses rather than reporting a clean reversal", function()
		-- The pre-M11 delivery shape carried the ids and nothing else. Treating that
		-- as "a reversal with no work to do" would report the tree restored when
		-- nothing had been touched at all.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Shop.Counter", property = "Transparency", value = { t = "Number", v = 0.75 } },
		}))

		local reversal = newRollback(applier):execute(deliveryFor(entry, { steps = {} }))
		t.falsy(Rollback.isFullyReversed(reversal), "an empty outcome list is a failure, not a success")
		t.equal(#reversal.outcomes, 1, "a refusal still says something a person can read")
		t.contains(reversal.outcomes[1].error, "no inverse operations")
	end)

	t.test("refuses an inverse it does not understand instead of reporting it replayed", function()
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Shop.Counter", property = "Transparency", value = { t = "Number", v = 0.75 } },
		}))

		local delivery = deliveryFor(entry)
		delivery.steps[1].inverse = { inverse = "restoreFromBackup", path = "Workspace.Shop.Counter" }
		local reversal = newRollback(applier):execute(delivery)
		t.falsy(Rollback.isFullyReversed(reversal))
		t.contains(reversal.outcomes[1].error, "does not understand the inverse")
	end)

	t.test("refuses to restore a deleted subtree over whatever took its place", function()
		-- Overwriting would destroy work this rollback was never asked to touch,
		-- and merging would leave a tree that is neither. Both are worse than
		-- saying so.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({ { op = "deleteInstance", path = "Workspace.Shop.Sign" } }))

		local squatter = Fake.new("Part", "Sign", { Anchored = false })
		squatter.Parent = Path.resolve(root, "Workspace.Shop")

		local reversal = newRollback(applier):execute(deliveryFor(entry))
		t.falsy(Rollback.isFullyReversed(reversal))
		t.contains(reversal.outcomes[1].error, "without overwriting it")
		t.equal(Path.resolve(root, "Workspace.Shop.Sign"), squatter, "the squatter is still there, untouched")
	end)

	t.test("does not delete whatever is standing where a created instance was", function()
		-- `deleteCreated` names a path, and something else may have taken it since.
		-- Destroying whatever is sitting there would be this plugin deleting work
		-- nobody asked it to touch.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({
			{ op = "createInstance", path = "Workspace.Shop.Door", className = "Part", properties = { Anchored = { t = "Bool", v = true } } },
		}))

		Path.resolve(root, "Workspace.Shop.Door"):Destroy()
		local replacement = Fake.new("Model", "Door")
		replacement.Parent = Path.resolve(root, "Workspace.Shop")

		local reversal = newRollback(applier):execute(deliveryFor(entry))
		t.truthy(Rollback.isFullyReversed(reversal), "the path is occupied by a Model, and Destroy is Destroy")
		t.isNil(Path.resolve(root, "Workspace.Shop.Door"))
	end)

	t.suite("Rollback — the journal entry that travels")

	t.test("builds the wire entry the daemon accepts, and leaves the live clones behind", function()
		-- `artefacts` holds live Instances for the session's own undo. They cannot
		-- be serialised, and a JSON encoder handed one either throws — losing the
		-- upload, and with it the only durable route back — or writes something
		-- meaningless.
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({ { op = "deleteInstance", path = "Workspace.Shop.Sign" } }))
		t.truthy(next(entry.artefacts), "the fixture has to produce a clone or it is testing nothing")

		local wire, err = Journal.wireEntry(entry, "44444444-4444-4444-8444-444444444444")
		t.isNil(err)
		t.equal(wire.projectId, "44444444-4444-4444-8444-444444444444")
		t.equal(wire.id, entry.id)
		t.equal(#wire.applied, 1)
		t.equal(#wire.inverses, 1)
		t.isNil(wire.artefacts, "a live Instance must never reach the wire")
		t.isNil(wire.notes)
		t.isNil(wire.rolledBackAt, "an apply has not been rolled back")
		-- The proof that it is serialisable at all, which is the whole point.
		t.contains(Fake.encodeJson(wire), "restoreSubtree")
	end)

	t.test("refuses to build an entry with nothing to reverse or nowhere to attach", function()
		local collectionService = fakeCollectionService()
		local root = place(collectionService)
		local applier = newApplier(root, collectionService)
		local _, entry = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Shop.Counter", property = "Transparency", value = { t = "Number", v = 0.75 } },
		}))

		local noProject, projectErr = Journal.wireEntry(entry, "")
		t.isNil(noProject)
		t.contains(projectErr, "no project id")

		local empty, emptyErr = Journal.wireEntry({ applied = {}, inverses = {} }, "44444444-4444-4444-8444-444444444444")
		t.isNil(empty)
		t.contains(emptyErr, "no inverses to upload")

		local broken, brokenErr = Journal.wireEntry(
			{ applied = { { index = 0 }, { index = 1 } }, inverses = { {} } },
			"44444444-4444-4444-8444-444444444444"
		)
		t.isNil(broken)
		t.contains(brokenErr, "the pairing is positional")
	end)
end
