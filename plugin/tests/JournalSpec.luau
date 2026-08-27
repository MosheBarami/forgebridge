--!nonstrict
local Journal = require("../src/Journal")
local Path = require("../src/Path")
local Value = require("../src/Value")
local Fake = require("./Fake")

local function options()
	return {
		encodeValue = Value.encode,
		encodeJson = Fake.encodeJson,
		parentPathOf = Path.parent,
		pathOf = Path.of,
	}
end

return function(t)
	t.suite("Journal — inverse capture")

	t.test("createInstance inverts to deleteCreated", function()
		local capture, err = Journal.capture(
			{ op = "createInstance", path = "Workspace.Widget", className = "Part" },
			nil,
			options()
		)
		t.isNil(err)
		t.equal(capture.inverse.inverse, "deleteCreated")
		t.equal(capture.inverse.path, "Workspace.Widget")
	end)

	t.test("setProperty inverts to restoreProperty carrying the previous value", function()
		local part = Fake.new("Part", "Part", { Transparency = 0.25 })
		local capture, err = Journal.capture(
			{ op = "setProperty", path = "Workspace.Part", property = "Transparency", value = { t = "Number", v = 1 } },
			part,
			options()
		)
		t.isNil(err)
		t.equal(capture.inverse.inverse, "restoreProperty")
		t.equal(capture.inverse.property, "Transparency")
		t.equal(capture.inverse.previous.t, "Number")
		t.equal(capture.inverse.previous.v, 0.25)
	end)

	t.test("setProperty refuses when the previous value cannot be read", function()
		local part = Fake.new("Part", "Part", { Transparency = 0 })
		local capture, err = Journal.capture(
			{ op = "setProperty", path = "Workspace.Part", property = "Nonsense", value = { t = "Number", v = 1 } },
			part,
			options()
		)
		t.isNil(capture, "no inverse means the operation must not run")
		t.contains(err, "Nonsense")
		t.contains(err, "cannot be journaled")
	end)

	t.test("setProperty refuses when the previous value cannot be encoded", function()
		local part = Fake.new("Part", "Part", { Callback = function() end })
		local capture, err = Journal.capture(
			{ op = "setProperty", path = "Workspace.Part", property = "Callback", value = { t = "Nil" } },
			part,
			options()
		)
		t.isNil(capture)
		t.contains(err, "cannot be journaled")
	end)

	t.test("writeScript over an existing script inverts to restoreSource", function()
		local script = Fake.new("ModuleScript", "Handler", { Source = "return 1" })
		local capture, err = Journal.capture(
			{ op = "writeScript", path = "ServerScriptService.Handler", scriptType = "ModuleScript", source = "return 2" },
			script,
			options()
		)
		t.isNil(err)
		t.equal(capture.inverse.inverse, "restoreSource")
		t.equal(capture.inverse.previousSource, "return 1")
	end)

	t.test("writeScript that creates the script inverts to deleteCreated", function()
		local capture, err = Journal.capture(
			{ op = "writeScript", path = "ServerScriptService.New", scriptType = "Script", source = "print(1)" },
			nil,
			options()
		)
		t.isNil(err)
		t.equal(capture.inverse.inverse, "deleteCreated", "otherwise a rollback leaves an orphan script behind")
	end)

	t.test("writeScript refuses a target with no readable Source", function()
		local folder = Fake.new("Folder", "Handler")
		local capture, err = Journal.capture(
			{ op = "writeScript", path = "ServerScriptService.Handler", scriptType = "Script", source = "x" },
			folder,
			options()
		)
		t.isNil(capture)
		t.contains(err, "no readable Source")
	end)

	t.test("moveInstance inverts to moveBack, pointing at where the instance ends up", function()
		local folder = Fake.new("Folder", "Shop")
		local capture, err = Journal.capture(
			{ op = "moveInstance", path = "ServerStorage.Shop", to = "ServerScriptService.Shop" },
			folder,
			options()
		)
		t.isNil(err)
		t.equal(capture.inverse.inverse, "moveBack")
		t.equal(capture.inverse.path, "ServerScriptService.Shop", "after the move it lives at `to`")
		t.equal(capture.inverse.from, "ServerStorage.Shop", "and belongs back where it came from")
	end)

	t.test("deleteInstance inverts to restoreSubtree with the parent and a clone", function()
		local root = Fake.dataModel({ "ServerScriptService" })
		local shop = Fake.folders(root, "ServerScriptService.Shop")
		local handler = Fake.new("ModuleScript", "Handler", { Source = "return {}" })
		handler.Parent = shop

		local capture, err = Journal.capture(
			{ op = "deleteInstance", path = "ServerScriptService.Shop" },
			shop,
			options()
		)
		t.isNil(err)
		t.equal(capture.inverse.inverse, "restoreSubtree")
		t.equal(capture.inverse.parentPath, "ServerScriptService")
		t.equal(type(capture.inverse.serialised), "string")
		t.contains(capture.inverse.serialised, "Handler")
		t.contains(capture.inverse.serialised, "return {}")
		t.truthy(capture.clone, "a live clone backs the in-session undo")
		t.truthy(capture.clone ~= shop)
		t.equal(capture.nodeCount, 2)
	end)

	t.test("deleteInstance says so when the subtree could not be cloned", function()
		local root = Fake.dataModel({ "ServerScriptService" })
		local shop = Fake.folders(root, "ServerScriptService.Shop")
		Fake.setArchivable(shop, false)

		local capture, err = Journal.capture({ op = "deleteInstance", path = "ServerScriptService.Shop" }, shop, options())
		t.isNil(err)
		t.isNil(capture.clone)
		t.contains(capture.note, "could not be cloned")
	end)

	t.test("deleteInstance refuses a service root", function()
		local root = Fake.dataModel({ "ServerScriptService" })
		local service = root:GetService("ServerScriptService")
		local capture, err = Journal.capture({ op = "deleteInstance", path = "ServerScriptService" }, service, options())
		t.isNil(capture)
		t.contains(err, "service root")
	end)

	t.test("an operation with no target refuses rather than inventing an inverse", function()
		local capture, err = Journal.capture({ op = "deleteInstance", path = "Workspace.Gone" }, nil, options())
		t.isNil(capture)
		t.contains(err, "does not exist")
	end)

	t.test("an unknown operation is refused by name", function()
		local capture, err = Journal.capture({ op = "renameInstance", path = "Workspace.Part" }, nil, options())
		t.isNil(capture)
		t.contains(err, "renameInstance")
	end)

	t.suite("Journal — subtree description")

	t.test("captures structure, attributes, tags and script source", function()
		local model = Fake.new("Model", "Shop", { WorldPivot = "pivot" })
		local script = Fake.new("Script", "Boot", { Source = "print('hi')" })
		script.Parent = model
		model:SetAttribute("Tier", 3)

		local tagged = {}
		local collectionService = {
			GetTags = function(_, instance)
				return if instance == model then { "shop" } else {}
			end,
		}
		tagged = collectionService

		local described = Journal.describeSubtree(model, {
			encodeValue = Value.encode,
			collectionService = tagged,
		})

		t.equal(described.className, "Model")
		t.equal(described.name, "Shop")
		t.equal(described.attributes.Tier.v, 3)
		t.equal(described.tags[1], "shop")
		t.equal(#described.children, 1)
		t.equal(described.children[1].source, "print('hi')")
		t.equal(Journal.countNodes(described), 2)
	end)

	t.suite("Journal — session")

	t.test("keeps the most recent entries and drops the oldest", function()
		local session = Journal.newSession(2)
		session:record({ id = "a" })
		session:record({ id = "b" })
		session:record({ id = "c" })
		local entries = session:entries()
		t.equal(#entries, 2)
		t.equal(entries[1].id, "b")
		t.equal(session:latest().id, "c")
	end)

	t.test("reports a subtree that came back incomplete rather than claiming a clean restore", function()
		-- The child's return was discarded and the Source write was pcall'd into
		-- silence, so a subtree missing whole branches reported success. The journal
		-- is the one record that must not be wrong about whether the place came back.
		local parent = Fake.new("Folder", "ServerScriptService")
		local restored, err = Journal.restoreSubtree(parent, {
			className = "Folder",
			name = "Shop",
			children = {
				{ className = "Script", name = "Handler", source = "print(1)" },
			},
		}, {
			instanceNew = function(className)
				if className == "Script" then
					local child = Fake.new("Script", "Handler")
					Fake.refuse(child, "Source", "Source is locked in this test")
					return child
				end
				return Fake.new(className, "Shop")
			end,
		})
		t.truthy(err, "a child whose source could not be restored must surface as an error")
		t.truthy(restored, "the partially restored instance is still handed back for the caller to decide")
	end)

	t.test("a subtree with nothing wrong still restores clean — the control", function()
		local parent = Fake.new("Folder", "ServerScriptService")
		local restored, err = Journal.restoreSubtree(parent, {
			className = "Folder",
			name = "Shop",
			children = { { className = "Folder", name = "Items" } },
		}, {
			instanceNew = function(className)
				return Fake.new(className, "node")
			end,
		})
		t.truthy(restored, "a clean subtree restores")
		t.falsy(err, "and reports no error")
	end)
end
