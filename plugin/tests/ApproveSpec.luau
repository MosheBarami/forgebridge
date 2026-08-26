--!nonstrict
local Approve = require("../src/Approve")
local Path = require("../src/Path")

local function validation(luauStatus, policyStatus)
	return {
		luau = { status = luauStatus or "ok", findings = {} },
		policy = { status = policyStatus or "ok", violations = {} },
		computedAt = "2026-01-01T00:00:00Z",
		computedBy = "test",
	}
end

local function set(operations, validationOverride)
	return {
		id = "22222222-2222-4222-8222-222222222222",
		summary = "test",
		operations = operations,
		validation = if validationOverride == false then nil else (validationOverride or validation()),
	}
end

local function blockedBy(decision, fragment)
	for _, blocker in decision.blockers do
		if string.find(blocker, fragment, 1, true) then
			return true
		end
	end
	return false
end

return function(t)
	t.suite("Approve — policy")

	local permissive = { autoApply = true, scope = "ServerScriptService.Shop", bulkDeleteThreshold = 10 }

	t.test("auto-applies a scoped, non-destructive set that writes no Luau", function()
		-- Everything this set does, the plugin checked for itself: the op kinds and
		-- the path scope. Nothing rests on the wire verdict.
		local decision = Approve.evaluate(
			set({
				{ op = "setProperty", path = "ServerScriptService.Shop.Handler", property = "Disabled", value = { t = "Bool", v = true } },
			}),
			permissive,
			Path.isWithin
		)
		t.truthy(decision.auto)
		t.equal(#decision.blockers, 0)
	end)

	t.test("a passing verdict from the wire never unlocks an apply that writes Luau", function()
		-- The verdict says the source is fine. This plugin has no way to check that
		-- — packages/luau-analysis does not run in Studio — so it is a human's call
		-- however green the verdict is (changeset.ts:20-22).
		local decision = Approve.evaluate(
			set({
				{ op = "writeScript", path = "ServerScriptService.Shop.Handler", scriptType = "ModuleScript", source = "return {}" },
			}),
			permissive,
			Path.isWithin
		)
		t.falsy(decision.auto)
		t.truthy(blockedBy(decision, "this plugin did not compute"))
	end)

	t.test("source smuggled through createInstance or setProperty blocks too", function()
		local created = Approve.evaluate(
			set({
				{
					op = "createInstance",
					path = "ServerScriptService.Shop.Handler",
					className = "ModuleScript",
					properties = { Source = { t = "String", v = "return {}" } },
				},
			}),
			permissive,
			Path.isWithin
		)
		t.falsy(created.auto, "a property bag carrying Source puts code in the place like any writeScript")

		local assigned = Approve.evaluate(
			set({
				{ op = "setProperty", path = "ServerScriptService.Shop.Handler", property = "Source", value = { t = "String", v = "return {}" } },
			}),
			permissive,
			Path.isWithin
		)
		t.falsy(assigned.auto)
	end)

	t.test("the verdict is reported with whose verdict it is", function()
		local verdict = validation("warn", "ok")
		verdict.computedBy = "core@0.1.0"
		local decision = Approve.evaluate(
			set({ { op = "setProperty", path = "ServerScriptService.Shop.A", property = "X", value = { t = "Nil" } } }, verdict),
			permissive,
			Path.isWithin
		)

		t.truthy(decision.validation.present)
		t.equal(decision.validation.origin, "core@0.1.0")
		t.equal(decision.validation.luau, "warn")
		t.contains(Approve.describeValidation(decision.validation), "not verified here")
		t.contains(Approve.describeValidation(decision.validation), "core@0.1.0")

		local advised = false
		for _, warning in decision.warnings do
			if string.find(warning, "advisory", 1, true) then
				advised = true
			end
		end
		t.truthy(advised, "a verdict shown without its origin reads as this plugin's own finding")
	end)

	t.test("describes a missing verdict as missing rather than as passing", function()
		local decision = Approve.evaluate(
			set({ { op = "setProperty", path = "ServerScriptService.Shop.A", property = "X", value = { t = "Nil" } } }, false),
			permissive,
			Path.isWithin
		)
		t.falsy(decision.validation.present)
		t.contains(Approve.describeValidation(decision.validation), "none reported")
	end)

	t.test("NEVER auto-applies a deleteInstance, whatever the settings say", function()
		local decision = Approve.evaluate(
			set({
				{ op = "deleteInstance", path = "ServerScriptService.Shop.Handler" },
			}),
			permissive,
			Path.isWithin
		)
		t.falsy(decision.auto, "ADR-012: deleteInstance is never auto-applied")
		t.truthy(blockedBy(decision, "never auto-applied"))
	end)

	t.test("a delete still blocks when it is buried among harmless operations", function()
		local decision = Approve.evaluate(
			set({
				{ op = "setProperty", path = "ServerScriptService.Shop.Handler", property = "Disabled", value = { t = "Bool", v = true } },
				{ op = "deleteInstance", path = "ServerScriptService.Shop.Old" },
				{ op = "writeScript", path = "ServerScriptService.Shop.New", scriptType = "Script", source = "" },
			}),
			permissive,
			Path.isWithin
		)
		t.falsy(decision.auto)
	end)

	t.test("approval is required when auto-apply is off", function()
		local decision = Approve.evaluate(
			set({ { op = "setProperty", path = "ServerScriptService.Shop.A", property = "X", value = { t = "Nil" } } }),
			{ autoApply = false, scope = "ServerScriptService.Shop" },
			Path.isWithin
		)
		t.falsy(decision.auto)
		t.truthy(blockedBy(decision, "auto-apply is off"))
	end)

	t.test("a path outside the scope blocks, and the scope is segment-aware", function()
		local decision = Approve.evaluate(
			set({ { op = "setProperty", path = "ServerScriptService.ShopAdmin.A", property = "X", value = { t = "Nil" } } }),
			permissive,
			Path.isWithin
		)
		t.falsy(decision.auto, "ShopAdmin is not inside Shop")
		t.truthy(blockedBy(decision, "outside the auto-apply scope"))
	end)

	t.test("an InstanceRef pointing out of scope blocks, wherever it hides", function()
		-- The operation's own path is inside the scope; the value it writes points
		-- somewhere else entirely. Checking only `operation.path` waved this through
		-- (pathsOf in packages/protocol/src/operation.ts).
		local assigned = Approve.evaluate(
			set({
				{
					op = "setProperty",
					path = "ServerScriptService.Shop.Handler",
					property = "Target",
					value = { t = "InstanceRef", path = "ServerScriptService.Admin.Console" },
				},
			}),
			permissive,
			Path.isWithin
		)
		t.falsy(assigned.auto)
		t.truthy(blockedBy(assigned, "ServerScriptService.Admin.Console"))

		local created = Approve.evaluate(
			set({
				{
					op = "createInstance",
					path = "ServerScriptService.Shop.Link",
					className = "ObjectValue",
					properties = { Value = { t = "InstanceRef", path = "Workspace.Secret" } },
				},
			}),
			permissive,
			Path.isWithin
		)
		t.falsy(created.auto)
		t.truthy(blockedBy(created, "Workspace.Secret"))
	end)

	t.test("a move is checked at both ends", function()
		local decision = Approve.evaluate(
			set({ { op = "moveInstance", path = "ServerScriptService.Shop.A", to = "ServerStorage.A" } }),
			permissive,
			Path.isWithin
		)
		t.falsy(decision.auto)
		t.truthy(blockedBy(decision, "ServerStorage.A"))
	end)

	t.test("auto-apply with no scope blocks rather than covering everything", function()
		local decision = Approve.evaluate(
			set({ { op = "setProperty", path = "Workspace.A", property = "X", value = { t = "Nil" } } }),
			{ autoApply = true, scope = "" },
			Path.isWithin
		)
		t.falsy(decision.auto)
		t.truthy(blockedBy(decision, "no path scope"))
	end)

	t.test("a ChangeSet with no validation verdict is treated as unvalidated", function()
		local decision = Approve.evaluate(
			set({ { op = "setProperty", path = "ServerScriptService.Shop.A", property = "X", value = { t = "Nil" } } }, false),
			permissive,
			Path.isWithin
		)
		t.falsy(decision.auto)
		t.truthy(blockedBy(decision, "no validation verdict"))
	end)

	t.test("a reported failure still blocks — advisory cuts one way only", function()
		local luauFailed = Approve.evaluate(
			set({ { op = "writeScript", path = "ServerScriptService.Shop.A", scriptType = "Script", source = "" } }, validation("fail", "ok")),
			permissive,
			Path.isWithin
		)
		t.falsy(luauFailed.auto)
		t.truthy(blockedBy(luauFailed, "static analysis"))

		local policyFailed = Approve.evaluate(
			set({ { op = "writeScript", path = "ServerScriptService.Shop.A", scriptType = "Script", source = "" } }, validation("ok", "fail")),
			permissive,
			Path.isWithin
		)
		t.falsy(policyFailed.auto)
		t.truthy(blockedBy(policyFailed, "policy check failed"))
	end)

	t.test("static-analysis warnings are surfaced but do not block on their own", function()
		local warned = validation("warn", "ok")
		warned.luau.findings = { { severity = "warning", rule = "luau/no-loadstring", message = "x" } }
		local decision = Approve.evaluate(
			set({ { op = "setProperty", path = "ServerScriptService.Shop.A", property = "X", value = { t = "Nil" } } }, warned),
			permissive,
			Path.isWithin
		)
		t.truthy(decision.auto)
		local reported = false
		for _, warning in decision.warnings do
			if string.find(warning, "1 finding", 1, true) then
				reported = true
			end
		end
		t.truthy(reported)
	end)

	t.test("a bulk delete is called out over the protocol threshold", function()
		local operations = {}
		for index = 1, 12 do
			table.insert(operations, { op = "deleteInstance", path = string.format("ServerScriptService.Shop.A%d", index) })
		end
		local decision = Approve.evaluate(set(operations), permissive, Path.isWithin)
		t.falsy(decision.auto)
		local warned = false
		for _, warning in decision.warnings do
			if string.find(warning, "bulk threshold", 1, true) then
				warned = true
			end
		end
		t.truthy(warned)
	end)

	t.test("every reason is collected, not just the first", function()
		local decision = Approve.evaluate(
			set({ { op = "deleteInstance", path = "Workspace.A" } }, false),
			{ autoApply = false, scope = "" },
			Path.isWithin
		)
		t.truthy(#decision.blockers >= 3, "a user who turned auto-apply on deserves all of why it still asked")
	end)
end
