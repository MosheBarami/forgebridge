--!nonstrict
--[[
	The approval panel is the human gate ADR-012 rests on, and these pin the one
	property that makes it a gate at all: a person approving must be able to see
	the Luau that is about to run in their place.

	Round-3 review found the panel reporting "0 script" over a ChangeSet that
	installed one, and clipping the code at 60 characters. Both came from the
	same wrong assumption — that a Script arrives only through an operation
	named `writeScript`. It arrives three ways, and the other two were invisible.
]]
local Diff = require("../src/Diff")

local LONG = string.rep("print('x') ", 40) -- comfortably past any 60-char clip

local function changeSet(operations)
	return { id = "cs", projectId = "p", baseVersion = 0, summary = "s", operations = operations }
end

-- A describe() that clips, exactly like the real Value.describe, so these tests
-- fail if the renderer ever routes Source back through it.
local function ctx()
	return {
		describe = function(value)
			local text = tostring(value.v)
			if #text > 60 then
				return string.format("%q…", string.sub(text, 1, 60))
			end
			return string.format("%q", text)
		end,
		resolve = function()
			return nil, "not found"
		end,
	}
end

return function(t)
	t.test("counts a createInstance carrying Source as a script", function()
		local summary = Diff.summarise(changeSet({
			{
				op = "createInstance", path = "ServerScriptService.A", className = "Script",
				properties = { Source = { t = "String", v = LONG } },
			},
		}))
		t.equal(summary.scripts, 1)
	end)

	t.test("counts a setProperty of Source as a script", function()
		local summary = Diff.summarise(changeSet({
			{ op = "setProperty", path = "ServerScriptService.A", property = "Source", value = { t = "String", v = LONG } },
		}))
		t.equal(summary.scripts, 1)
	end)

	t.test("does not count a property write that installs no code", function()
		local summary = Diff.summarise(changeSet({
			{ op = "setProperty", path = "Workspace.Part", property = "Transparency", value = { t = "Number", v = 0.5 } },
		}))
		t.equal(summary.scripts, 0)
	end)

	t.test("shows a createInstance Source in full, unclipped", function()
		local rendered = Diff.render(changeSet({
			{
				op = "createInstance", path = "ServerScriptService.A", className = "Script",
				properties = { Source = { t = "String", v = LONG } },
			},
		}), ctx())
		t.equal(rendered.entries[1].source, LONG)
	end)

	t.test("shows a setProperty Source in full, unclipped", function()
		local rendered = Diff.render(changeSet({
			{ op = "setProperty", path = "ServerScriptService.A", property = "Source", value = { t = "String", v = LONG } },
		}), ctx())
		t.equal(rendered.entries[1].source, LONG)
	end)

	-- The end-to-end one. The two tests above pass on entry.source alone, and
	-- entry.source was invisible to toText — so the panel still showed nothing.
	-- This asserts against the text a person reads.
	t.test("the rendered panel text actually contains the code", function()
		local marked = "print('marker-alpha')\n" .. string.rep("local y = 1\n", 4) .. "print('marker-omega')"
		local text = Diff.toText(Diff.render(changeSet({
			{
				op = "createInstance", path = "ServerScriptService.A", className = "Script",
				properties = { Source = { t = "String", v = marked } },
			},
		}), ctx()))
		t.truthy(string.find(text, "marker%-alpha"), "the panel must show the start of the source")
		t.truthy(string.find(text, "marker%-omega"), "the panel must show the end of the source")
	end)
end
