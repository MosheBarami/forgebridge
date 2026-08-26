--!nonstrict
local Apply = require("../src/Apply")
local Journal = require("../src/Journal")
local Path = require("../src/Path")
local Value = require("../src/Value")
local Fake = require("./Fake")

--[[
	`options.changeHistory` stands in for ChangeHistoryService and
	`options.onNew` gets a look at every instance the applier constructs, which is
	how a test arranges for the engine to refuse a write on one of them.
]]
local function newApplier(root, options)
	local counter = 0
	local opts = options or {}
	return Apply.new({
		root = root,
		path = Path,
		value = Value,
		journal = Journal,
		changeHistory = opts.changeHistory,
		instanceNew = function(className)
			-- A freshly constructed Instance admits whatever its class supports.
			local instance = Fake.new(className, className, nil, true)
			if opts.onNew then
				opts.onNew(instance)
			end
			return instance
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
	})
end

--- Resolve for assertions. `Path.resolve` returns an optional; tests want the value.
local function at(root, path): any
	return (Path.resolve(root, path))
end

local function changeSet(operations, baseVersion)
	return {
		id = "11111111-1111-4111-8111-111111111111",
		baseVersion = baseVersion or 4,
		summary = "test set",
		operations = operations,
	}
end

local function place()
	local root = Fake.dataModel({ "Workspace", "ServerScriptService", "ServerStorage" })
	local part = Fake.new("Part", "Part", { Anchored = false, Transparency = 0 })
	part.Parent = root:GetService("Workspace")
	return root
end

return function(t)
	t.suite("Apply")

	t.test("applies operations in order and reports zero-based indices", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Anchored", value = { t = "Bool", v = true } },
			{ op = "setProperty", path = "Workspace.Part", property = "Transparency", value = { t = "Number", v = 0.5 } },
		}))

		t.truthy(Apply.isFullyApplied(result))
		t.equal(#result.outcomes, 2)
		t.equal(result.outcomes[1].index, 0, "the protocol counts operations from zero")
		t.equal(result.outcomes[2].index, 1)
		t.equal(at(root, "Workspace.Part").Anchored, true)
		t.equal(at(root, "Workspace.Part").Transparency, 0.5)
		t.equal(result.newVersion, 5)
		t.equal(result.pluginVersion, "0.1.0-test")
	end)

	t.test("a partial apply is reported as partial and never rounded up", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Anchored", value = { t = "Bool", v = true } },
			{ op = "setProperty", path = "Workspace.Missing", property = "Anchored", value = { t = "Bool", v = true } },
			{ op = "setProperty", path = "Workspace.Part", property = "Transparency", value = { t = "Number", v = 1 } },
		}))

		t.falsy(Apply.isFullyApplied(result))
		t.truthy(result.outcomes[1].ok)
		t.falsy(result.outcomes[2].ok)
		t.contains(result.outcomes[2].error, "does not exist")
		t.falsy(result.outcomes[3].ok)
		t.contains(result.outcomes[3].error, "not attempted: operation 1 failed")
		t.equal(at(root, "Workspace.Part").Transparency, 0, "operations after a failure must not run")
		t.equal(Apply.summarise(result), "1 of 3 operations applied")
	end)

	t.test("refuses a stale baseVersion instead of merging", function()
		local root = place()
		local applier = newApplier(root)
		applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Anchored", value = { t = "Bool", v = true } },
		}, 4))

		local result = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Transparency", value = { t = "Number", v = 1 } },
		}, 4))

		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "rebased")
		t.equal(result.newVersion, 5, "a refused set does not move the version")
		t.equal(at(root, "Workspace.Part").Transparency, 0)
	end)

	t.test("an operation whose inverse cannot be captured does not run", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Nonsense", value = { t = "Number", v = 1 } },
		}))

		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "cannot be journaled")
		local readOk = pcall(function()
			return at(root, "Workspace.Part").Nonsense
		end)
		t.falsy(readOk, "the property must not have been created")
	end)

	t.test("creates an instance, parenting it last", function()
		local root = place()
		local applier = newApplier(root)
		local result, entry = applier:execute(changeSet({
			{
				op = "createInstance",
				path = "Workspace.Widget",
				className = "Part",
				properties = { Transparency = { t = "Number", v = 0.5 } },
			},
		}))

		t.truthy(Apply.isFullyApplied(result))
		local created = at(root, "Workspace.Widget")
		t.equal(created.ClassName, "Part")
		t.equal(created.Name, "Widget")
		t.equal(created.Transparency, 0.5)
		t.equal(entry.inverses[1].inverse, "deleteCreated")
	end)

	t.test("refuses to create over an occupied path", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{ op = "createInstance", path = "Workspace.Part", className = "Part", properties = {} },
		}))
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "already exists")
	end)

	t.test("refuses a create that tries to set its own Parent", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{
				op = "createInstance",
				path = "Workspace.Widget",
				className = "Part",
				properties = { Parent = { t = "InstanceRef", path = "Workspace" } },
			},
		}))
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "may not set Parent")
	end)

	t.test("refuses a create whose Name contradicts its path", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{
				op = "createInstance",
				path = "Workspace.Widget",
				className = "Part",
				properties = { Name = { t = "String", v = "Gadget" } },
			},
		}))
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "refusing to guess")
	end)

	t.test("refuses an unknown datatype and leaves the property alone", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Transparency", value = { t = "Decimal", v = 1 } },
		}))
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "Decimal")
		t.equal(at(root, "Workspace.Part").Transparency, 0)
	end)

	t.test("writes a new script and journals a delete as its inverse", function()
		local root = place()
		local applier = newApplier(root)
		local result, entry = applier:execute(changeSet({
			{
				op = "writeScript",
				path = "ServerScriptService.Boot",
				scriptType = "Script",
				source = "print('hello')",
			},
		}))

		t.truthy(Apply.isFullyApplied(result))
		local created = at(root, "ServerScriptService.Boot")
		t.equal(created.ClassName, "Script")
		t.equal(created.Source, "print('hello')")
		t.equal(entry.inverses[1].inverse, "deleteCreated")
	end)

	t.test("refuses to overwrite an instance of a different class", function()
		local root = place()
		local folder = Fake.new("Folder", "Boot")
		folder.Parent = root:GetService("ServerScriptService")

		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{ op = "writeScript", path = "ServerScriptService.Boot", scriptType = "Script", source = "print(1)" },
		}))
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "refusing to replace it")
	end)

	t.test("moves an instance and journals where it came from", function()
		local root = place()
		local shop = Fake.new("Folder", "Shop")
		shop.Parent = root:GetService("ServerStorage")

		local applier = newApplier(root)
		local result, entry = applier:execute(changeSet({
			{ op = "moveInstance", path = "ServerStorage.Shop", to = "ServerScriptService.Shop" },
		}))

		t.truthy(Apply.isFullyApplied(result))
		t.truthy(Path.resolve(root, "ServerScriptService.Shop"))
		t.isNil(Path.resolve(root, "ServerStorage.Shop"))
		t.equal(entry.inverses[1].from, "ServerStorage.Shop")
	end)

	t.test("refuses to move an instance inside itself", function()
		local root = place()
		local shop = Fake.new("Folder", "Shop")
		shop.Parent = root:GetService("ServerStorage")
		local inner = Fake.new("Folder", "Inner")
		inner.Parent = shop

		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{ op = "moveInstance", path = "ServerStorage.Shop", to = "ServerStorage.Shop.Inner.Shop" },
		}))
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "inside itself")
	end)

	t.test("deletes and journals the whole subtree first", function()
		local root = place()
		local shop = Fake.new("Folder", "Shop")
		shop.Parent = root:GetService("ServerScriptService")
		local handler = Fake.new("ModuleScript", "Handler", { Source = "return {}" })
		handler.Parent = shop

		local applier = newApplier(root)
		local result, entry = applier:execute(changeSet({
			{ op = "deleteInstance", path = "ServerScriptService.Shop" },
		}))

		t.truthy(Apply.isFullyApplied(result))
		t.isNil(Path.resolve(root, "ServerScriptService.Shop"))
		t.equal(entry.inverses[1].inverse, "restoreSubtree")
		t.contains(entry.inverses[1].serialised, "return {}")
	end)

	t.test("a Name the engine refuses fails the operation, not the poll loop", function()
		local root = place()
		local applier = newApplier(root, {
			onNew = function(instance)
				Fake.refuse(instance, "Name", "Name is locked")
			end,
		})
		-- Unguarded, the raw `instance.Name = name` threw straight out of execute
		-- and took the caller's loop with it, losing the journal entry as it went.
		local result = applier:execute(changeSet({
			{ op = "createInstance", path = "Workspace.Widget", className = "Part", properties = {} },
		}))

		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "could not be named")
		t.contains(result.outcomes[1].error, "Name is locked")
		t.isNil(Path.resolve(root, "Workspace.Widget"), "nothing half-built may be left behind")
	end)

	t.test("a Parent the engine refuses fails the operation and destroys the orphan", function()
		local root = place()
		local workspace = root:GetService("Workspace")
		local created: any = nil
		local applier = newApplier(root, {
			onNew = function(instance)
				created = instance
				-- Refused only for this destination, so the applier can still destroy
				-- the orphan it is left holding.
				Fake.refuse(instance, "Parent", "The Parent property of Workspace is locked", workspace)
			end,
		})
		local result = applier:execute(changeSet({
			{ op = "createInstance", path = "Workspace.Widget", className = "Part", properties = {} },
		}))

		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "could not be parented")
		t.isNil(Path.resolve(root, "Workspace.Widget"))
		t.truthy(Fake.isDestroyed(created), "the orphan must not be left floating")
	end)

	t.test("refuses setProperty on Parent and Name even though the schema already does", function()
		local root = place()
		local shop = Fake.new("Folder", "Shop")
		shop.Parent = root:GetService("ServerStorage")

		local applier = newApplier(root)
		local reparent = applier:execute(changeSet({
			{
				op = "setProperty",
				path = "ServerStorage.Shop",
				property = "Parent",
				value = { t = "InstanceRef", path = "Workspace" },
			},
		}))
		t.falsy(reparent.outcomes[1].ok)
		t.contains(reparent.outcomes[1].error, "use moveInstance")
		t.truthy(Path.resolve(root, "ServerStorage.Shop"), "the subtree must not have moved")
		t.isNil(Path.resolve(root, "Workspace.Shop"))

		local rename = applier:execute(changeSet({
			{ op = "setProperty", path = "ServerStorage.Shop", property = "Name", value = { t = "String", v = "Other" } },
		}, 4))
		t.falsy(rename.outcomes[1].ok)
		t.contains(rename.outcomes[1].error, "use moveInstance")
		t.equal(at(root, "ServerStorage.Shop").Name, "Shop")
	end)

	t.test("a move whose rename fails still journals its inverse", function()
		local root = place()
		local shop = Fake.new("Folder", "Shop")
		shop.Parent = root:GetService("ServerStorage")
		Fake.refuse(shop, "Name", "Name is locked")

		local applier = newApplier(root)
		local result, entry = applier:execute(changeSet({
			{ op = "moveInstance", path = "ServerStorage.Shop", to = "ServerScriptService.Other" },
		}))

		-- The reparent landed and the rename did not, so the operation reports as
		-- failed — but the mutation must never be journal-less.
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "could not be renamed")
		t.equal(#entry.inverses, 1, "a mutation with no inverse is exactly what the journal exists to prevent")
		t.equal(entry.inverses[1].inverse, "moveBack")
		t.equal(entry.inverses[1].from, "ServerStorage.Shop")
		t.truthy(Path.resolve(root, "ServerStorage.Shop"), "the best-effort restore puts it back")
		t.contains(entry.notes[1], "put back")
	end)

	t.test("a move whose rename and restore both fail still journals its inverse", function()
		local root = place()
		local storage = root:GetService("ServerStorage")
		local shop = Fake.new("Folder", "Shop")
		shop.Parent = storage
		Fake.refuse(shop, "Name", "Name is locked")
		-- Refused only on the way back, so the reparent succeeds and the restore
		-- cannot undo it.
		Fake.refuse(shop, "Parent", "The Parent property of ServerStorage is locked", storage)

		local applier = newApplier(root)
		local result, entry = applier:execute(changeSet({
			{ op = "moveInstance", path = "ServerStorage.Shop", to = "ServerScriptService.Other" },
		}))

		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "still at the new parent")
		t.equal(#entry.inverses, 1)
		t.equal(entry.inverses[1].inverse, "moveBack")
		t.truthy(Path.resolve(root, "ServerScriptService.Shop"), "it really did move and really is stuck there")
		t.contains(entry.notes[1], "could not be put back")
		t.equal(entry.versionAfter, entry.versionBefore + 1, "the tree changed, so the version has to move")
	end)

	t.test("refuses the whole set when Studio will not open an undo waypoint", function()
		local root = place()
		local applier = newApplier(root, {
			changeHistory = {
				-- What ChangeHistoryService answers when a recording is already open.
				TryBeginRecording = function()
					return nil
				end,
				FinishRecording = function() end,
			},
		})
		local result, entry = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Anchored", value = { t = "Bool", v = true } },
			{ op = "deleteInstance", path = "Workspace.Part" },
		}))

		t.equal(#result.outcomes, 2, "every operation still gets an outcome")
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "undo waypoint")
		t.falsy(result.outcomes[2].ok)
		t.equal(at(root, "Workspace.Part").Anchored, false, "an apply with no way back must not happen at all")
		t.truthy(Path.resolve(root, "Workspace.Part"))
		t.contains(entry.refused, "undo waypoint")
		t.equal(result.newVersion, 4, "nothing was applied, so the version stays put")
	end)

	t.test("applies normally when Studio does open a recording", function()
		local root = place()
		local began = 0
		local applier = newApplier(root, {
			changeHistory = {
				TryBeginRecording = function()
					began += 1
					return "recording-1"
				end,
				-- FinishRecording takes an Enum this runtime does not have, so the
				-- applier's own pcall around it is what the test relies on here.
				FinishRecording = function() end,
			},
		})
		local result = applier:execute(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Anchored", value = { t = "Bool", v = true } },
		}))

		t.truthy(Apply.isFullyApplied(result))
		t.equal(began, 1)
		t.equal(at(root, "Workspace.Part").Anchored, true)
	end)

	t.test("refuses an operation it does not understand", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({
			{ op = "renameInstance", path = "Workspace.Part" },
		}))
		t.falsy(result.outcomes[1].ok)
		t.contains(result.outcomes[1].error, "renameInstance")
	end)

	t.test("refuses an empty set without inventing an outcome", function()
		local root = place()
		local applier = newApplier(root)
		local result = applier:execute(changeSet({}))
		t.equal(#result.outcomes, 0)
		t.falsy(Apply.isFullyApplied(result))
	end)
end
