--!nonstrict
--[[
	The plugin's unit tests.

	These cover the parts that would be a security or data-loss bug if they were
	wrong: path resolution refusing a missing ancestor, the PropertyValue decoder
	refusing a tag it does not know, inverse capture for every operation kind,
	partial applies being reported as partial, the transport stopping dead on 426,
	and deleteInstance never being auto-applied.

	They deliberately touch no Roblox API, so they run in any Luau runtime with
	require-by-string. See plugin/README.md.
]]

local passed = 0
local failed = 0

local t = {}

function t.suite(name: string)
	print(string.format("\n── %s", name))
end

function t.test(name: string, fn: () -> ())
	local ok, err = pcall(fn)
	if ok then
		passed += 1
		print(string.format("  ok   %s", name))
	else
		failed += 1
		print(string.format("  FAIL %s\n       %s", name, tostring(err)))
	end
end

local function show(value: any): string
	if type(value) == "string" then
		return string.format("%q", value)
	end
	return tostring(value)
end

function t.equal(actual: any, expected: any, message: string?)
	if actual ~= expected then
		error(string.format("%sexpected %s, got %s", if message then message .. ": " else "", show(expected), show(actual)), 2)
	end
end

function t.truthy(value: any, message: string?)
	if not value then
		error(message or "expected a truthy value", 2)
	end
end

function t.falsy(value: any, message: string?)
	if value then
		error(string.format("%sexpected a falsy value, got %s", if message then message .. ": " else "", show(value)), 2)
	end
end

function t.isNil(value: any, message: string?)
	if value ~= nil then
		error(string.format("%sexpected nil, got %s", if message then message .. ": " else "", show(value)), 2)
	end
end

function t.contains(haystack: any, needle: string, message: string?)
	if type(haystack) ~= "string" or not string.find(haystack, needle, 1, true) then
		error(
			string.format("%sexpected %s to contain %q", if message then message .. ": " else "", show(haystack), needle),
			2
		)
	end
end

local suites = {
	require("./PathSpec"),
	require("./ValueSpec"),
	require("./JournalSpec"),
	require("./ApplySpec"),
	require("./ApproveSpec"),
	require("./TransportSpec"),
}

for _, suite in suites do
	suite(t)
end

print(string.format("\n%d passed, %d failed", passed, failed))
if failed > 0 then
	error(string.format("%d test(s) failed", failed), 0)
end
