--!nonstrict
local Path = require("../src/Path")
local Fake = require("./Fake")

return function(t)
	t.suite("Path")

	local function tree()
		local root = Fake.dataModel({ "ServerScriptService", "Workspace" })
		Fake.folders(root, "ServerScriptService.Shop")
		Fake.folders(root, "ServerScriptService.ShopAdmin")
		return root
	end

	t.test("resolves an existing path", function()
		local root = tree()
		local instance, err = Path.resolve(root, "ServerScriptService.Shop")
		t.isNil(err)
		t.equal(instance.Name, "Shop")
	end)

	t.test("refuses a missing ancestor and names where it stopped", function()
		local root = tree()
		local instance, err = Path.resolve(root, "ServerScriptService.Shop.Missing.Handler")
		t.isNil(instance)
		t.contains(err, "ServerScriptService.Shop.Missing")
		t.contains(err, "does not exist")
		t.contains(err, 'resolved as far as "ServerScriptService.Shop"')
	end)

	t.test("resolving a missing ancestor creates nothing", function()
		local root = tree()
		local service = root:GetService("ServerScriptService")
		local before = #service:GetChildren()
		Path.resolve(root, "ServerScriptService.Nowhere.Deep")
		t.equal(#service:GetChildren(), before, "the tree must be untouched")
	end)

	t.test("refuses a segment that is not a safe identifier", function()
		local root = tree()
		local instance, err = Path.resolve(root, "ServerScriptService.Shop-Admin")
		t.isNil(instance)
		t.contains(err, "not a safe identifier")
	end)

	t.test("refuses an empty segment", function()
		local instance, err = Path.resolve(tree(), "ServerScriptService..Shop")
		t.isNil(instance)
		t.contains(err, "empty segment")
	end)

	t.test("refuses a root that is not an addressable service", function()
		local instance, err = Path.resolve(tree(), "CoreGui.Thing")
		t.isNil(instance)
		t.contains(err, "not an addressable service root")
	end)

	t.test("refuses a path deeper than the protocol limit", function()
		local segments = { "Workspace" }
		for index = 1, Path.MAX_DEPTH do
			table.insert(segments, string.format("a%d", index))
		end
		local instance, err = Path.resolve(tree(), table.concat(segments, "."))
		t.isNil(instance)
		t.contains(err, "max depth")
	end)

	t.test("refuses an over-long segment", function()
		local instance, err = Path.resolve(tree(), "Workspace." .. string.rep("a", Path.MAX_SEGMENT_LENGTH + 1))
		t.isNil(instance)
		t.contains(err, "exceeds 100 characters")
	end)

	t.test("resolveParent yields the parent and the leaf name", function()
		local root = tree()
		local parent, name, err = Path.resolveParent(root, "ServerScriptService.Shop.NewHandler")
		t.isNil(err)
		t.equal(parent.Name, "Shop")
		t.equal(name, "NewHandler")
	end)

	t.test("resolveParent refuses a missing ancestor", function()
		local parent, name, err = Path.resolveParent(tree(), "ServerScriptService.Missing.NewHandler")
		t.isNil(parent)
		t.isNil(name)
		t.contains(err, "does not exist")
	end)

	t.test("resolveParent refuses to create a service root", function()
		local parent, _, err = Path.resolveParent(tree(), "Workspace")
		t.isNil(parent)
		t.contains(err, "service root")
	end)

	t.test("isWithin is segment-aware, not a prefix match", function()
		t.truthy(Path.isWithin("ServerScriptService.Shop", "ServerScriptService.Shop"))
		t.truthy(Path.isWithin("ServerScriptService.Shop.Handler", "ServerScriptService.Shop"))
		-- The bug that turns a scope allowlist into a hole.
		t.falsy(Path.isWithin("ServerScriptService.ShopAdmin", "ServerScriptService.Shop"))
		t.falsy(Path.isWithin("ServerScriptService", "ServerScriptService.Shop"))
	end)

	t.test("parent and name split the way the protocol does", function()
		t.equal(Path.parent("ServerScriptService.Shop.Handler"), "ServerScriptService.Shop")
		t.equal(Path.name("ServerScriptService.Shop.Handler"), "Handler")
		t.isNil(Path.parent("Workspace"))
	end)

	t.test("of() walks an instance back to its service root", function()
		local root = tree()
		local handler = Fake.new("ModuleScript", "Handler")
		handler.Parent = Path.resolve(root, "ServerScriptService.Shop")
		t.equal(Path.of(handler), "ServerScriptService.Shop.Handler")
	end)
end
