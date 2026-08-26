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

	t.suite("Approve — fail-closed regressions")

	t.test("un-disabling a script already inside the scope is not an auto-apply", function()
		-- The ChangeSet carries no Luau, so nothing analysed anything and nothing
		-- could have: the operation is one property write, and what it does is
		-- start a Script that was sitting in the scope switched off. `carriesSource`
		-- looked for a Source, found none, and said nothing — which made "I see no
		-- code in this operation" and "this operation runs no code" the same answer.
		local decision = Approve.evaluate(
			set({
				{
					op = "setProperty",
					path = "ServerScriptService.Shop.Handler",
					property = "Disabled",
					value = { t = "Bool", v = false },
				},
			}),
			permissive,
			Path.isWithin
		)
		t.falsy(decision.auto, "ADR-012: starting dormant code is as consequential as installing it")
		t.truthy(blockedBy(decision, "start code that is already in the place"))
		t.truthy(blockedBy(decision, "Disabled"), "the blocker names the property responsible")
	end)

	t.test("disabling one still auto-applies, and so does an ordinary property", function()
		-- The control, and the sharpest one available: the same property, the
		-- opposite consequence. Whatever the script was doing, after `Disabled =
		-- true` it is not running, so it cannot be the operation the rule above is
		-- for. A rule that fires here — or on a Transparency — is one people learn
		-- to click through, and then the narrow exception stops being useful, which
		-- is the same outcome as having no rule.
		local stopped = Approve.evaluate(
			set({
				{
					op = "setProperty",
					path = "ServerScriptService.Shop.Handler",
					property = "Disabled",
					value = { t = "Bool", v = true },
				},
			}),
			permissive,
			Path.isWithin
		)
		t.truthy(stopped.auto, "turning a script off can never start code")

		local ordinary = Approve.evaluate(
			set({
				{
					op = "setProperty",
					path = "ServerScriptService.Shop.Sign",
					property = "Transparency",
					value = { t = "Number", v = 0.5 },
				},
			}),
			permissive,
			Path.isWithin
		)
		t.truthy(ordinary.auto, "the auto-apply exception has to still cover ordinary property writes")
	end)

	t.test("a RunContext write is a human's call whatever it is set to", function()
		-- Server or Client makes a Script run where it sits, including somewhere
		-- that has never run one. Legacy is not a safe opposite: `evaluate` holds
		-- the ChangeSet and no DataModel, so it cannot read what the RunContext is
		-- now, and cannot tell the write that stops a script from the one that
		-- starts it.
		for _, value in { "Server", "Client", "Legacy" } do
			local decision = Approve.evaluate(
				set({
					{
						op = "setProperty",
						path = "ServerScriptService.Shop.Handler",
						property = "RunContext",
						value = { t = "Enum", enum = "RunContext", value = value },
					},
				}),
				permissive,
				Path.isWithin
			)
			t.falsy(decision.auto, string.format("RunContext = %s must not auto-apply", value))
			t.truthy(blockedBy(decision, "RunContext"))
		end

		-- Control: an Enum write that decides nothing about whether code runs.
		local font = Approve.evaluate(
			set({
				{
					op = "setProperty",
					path = "ServerScriptService.Shop.Sign",
					property = "Font",
					value = { t = "Enum", enum = "Font", value = "Code" },
				},
			}),
			permissive,
			Path.isWithin
		)
		t.truthy(font.auto)
	end)

	t.test("a Disabled value this plugin cannot read blocks rather than passes", function()
		-- Only a literal Bool true is demonstrably a stop. A string that spells a
		-- boolean, a Nil, a number, a value that never arrived: each is a shape this
		-- rule cannot resolve, and an unresolvable value is treated as the dangerous
		-- one rather than waved through for not matching the shape it looks for.
		local unreadable = {
			{ t = "String", v = "true" },
			{ t = "Nil" },
			{ t = "Int", v = 1 },
		}
		for _, value in unreadable do
			local decision = Approve.evaluate(
				set({
					{ op = "setProperty", path = "ServerScriptService.Shop.Handler", property = "Disabled", value = value },
				}),
				permissive,
				Path.isWithin
			)
			t.falsy(decision.auto, string.format("a Disabled of tag %s is not a readable stop", tostring(value.t)))
		end

		local missing = Approve.evaluate(
			set({ { op = "setProperty", path = "ServerScriptService.Shop.Handler", property = "Disabled" } }),
			permissive,
			Path.isWithin
		)
		t.falsy(missing.auto, "an absent value is the least readable of all")
	end)

	t.test("the panel names every reason the set was held", function()
		-- Asserted against the text a person reads, not against the decision object:
		-- `evaluate` computed these reasons and `Widget:present` rendered only the
		-- warnings, so the panel offered Approve and Reject and never said why it
		-- was asking. `Approve.describeNotes` is the whole of that block on screen.
		local decision = Approve.evaluate(
			set({
				{ op = "writeScript", path = "ServerScriptService.Shop.New", scriptType = "Script", source = "print(1)" },
				{ op = "setProperty", path = "ServerScriptService.Admin.Console", property = "X", value = { t = "Nil" } },
			}),
			permissive,
			Path.isWithin
		)
		t.truthy(#decision.blockers >= 2)

		local notes = Approve.describeNotes(decision, 0)
		t.contains(notes, "Approval required")
		for _, blocker in decision.blockers do
			t.contains(notes, blocker, "a reason the code computed and the panel dropped on the floor")
		end
	end)

	t.test("the note block still carries the warnings and the destruction count", function()
		-- Control for the same change: blockers were added to that block, and
		-- nothing already in it may have been pushed out.
		local decision = Approve.evaluate(
			set({ { op = "setProperty", path = "ServerScriptService.Shop.A", property = "X", value = { t = "Nil" } } }),
			permissive,
			Path.isWithin
		)
		t.truthy(decision.auto, "nothing here needs a human")

		local notes = Approve.describeNotes(decision, 4)
		t.falsy(string.find(notes, "Approval required", 1, true), "a set that auto-applies has no reasons to list")
		t.contains(notes, "! the validation verdict was computed by")
		t.contains(notes, "! 4 instances would be destroyed")
	end)

	t.test("a note block with nothing to say is empty, so the panel can hide it", function()
		local nothing = Approve.describeNotes(
			{ auto = true, blockers = {}, warnings = {}, validation = { present = false } },
			0
		)
		t.equal(nothing, "")
	end)
end
