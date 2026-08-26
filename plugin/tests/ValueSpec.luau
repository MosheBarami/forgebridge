--!nonstrict
local Value = require("../src/Value")

--[[
	Stand-ins for the Roblox datatype constructors. They record what they were
	handed, which is the only way to prove the CFrame rotation order survives
	the crossing.
]]
local function constructors()
	local function recorder(name)
		return {
			new = function(...)
				return { __type = name, args = { ... } }
			end,
		}
	end
	local ctors = {
		Vector3 = recorder("Vector3"),
		Vector2 = recorder("Vector2"),
		Color3 = recorder("Color3"),
		UDim = recorder("UDim"),
		UDim2 = recorder("UDim2"),
		Rect = recorder("Rect"),
		CFrame = recorder("CFrame"),
		NumberRange = recorder("NumberRange"),
		Enum = { Sample = { Member = "Enum.Sample.Member" } },
		BrickColor = {
			new = function(name)
				-- Mirrors the real BrickColor.new, which silently substitutes a
				-- default colour for a name it does not know.
				if name == "Bright red" then
					return { Name = "Bright red" }
				end
				return { Name = "Medium stone grey" }
			end,
		},
	}
	return ctors
end

return function(t)
	t.suite("Value")

	t.test("an unknown tag is an error naming the tag", function()
		local ok, err = Value.decode({ t = "Quaternion", x = 1 }, constructors())
		t.falsy(ok)
		t.contains(err, "Quaternion")
		t.contains(err, "this plugin understands")
		t.contains(err, "Vector3")
	end)

	t.test("a missing tag is an error, not a guess", function()
		local ok, err = Value.decode({ v = 12 }, constructors())
		t.falsy(ok)
		t.contains(err, "missing its `t` tag")
	end)

	t.test("a non-table is an error", function()
		local ok, err = Value.decode("Bright red", constructors())
		t.falsy(ok)
		t.contains(err, "must be an object")
	end)

	t.test("decodes scalars", function()
		local ok, value = Value.decode({ t = "String", v = "hello" })
		t.truthy(ok)
		t.equal(value, "hello")

		ok, value = Value.decode({ t = "Bool", v = false })
		t.truthy(ok)
		t.equal(value, false)

		ok, value = Value.decode({ t = "Nil" })
		t.truthy(ok, "Nil decodes successfully to nil, which is why ok is the discriminator")
		t.isNil(value)
	end)

	t.test("refuses a mistyped scalar", function()
		local ok, err = Value.decode({ t = "Number", v = "12" })
		t.falsy(ok)
		t.contains(err, "finite number")

		ok, err = Value.decode({ t = "Int", v = 1.5 })
		t.falsy(ok)
		t.contains(err, "whole number")
	end)

	t.test("refuses a non-finite number", function()
		local ok = Value.decode({ t = "Number", v = math.huge })
		t.falsy(ok)
	end)

	t.test("decodes a Vector3 and refuses a broken one", function()
		local ok, value = Value.decode({ t = "Vector3", x = 1, y = 2, z = 3 }, constructors())
		t.truthy(ok)
		t.equal(value.args[2], 2)

		local badOk, err = Value.decode({ t = "Vector3", x = 1, y = 2 }, constructors())
		t.falsy(badOk)
		t.contains(err, "finite x, y and z")
	end)

	t.test("hands the CFrame rotation over in the protocol's row-major order", function()
		local ok, value = Value.decode({
			t = "CFrame",
			position = { 10, 20, 30 },
			rotation = { 1, 2, 3, 4, 5, 6, 7, 8, 9 },
		}, constructors())
		t.truthy(ok)
		t.equal(#value.args, 12)
		t.equal(value.args[1], 10)
		t.equal(value.args[4], 1)
		t.equal(value.args[12], 9)
	end)

	t.test("refuses a CFrame with the wrong number of rotation components", function()
		local ok, err = Value.decode({ t = "CFrame", position = { 0, 0, 0 }, rotation = { 1, 2, 3 } }, constructors())
		t.falsy(ok)
		t.contains(err, "rotation")
	end)

	t.test("catches a BrickColor name the engine would silently substitute", function()
		local ok = Value.decode({ t = "BrickColor", name = "Bright red" }, constructors())
		t.truthy(ok)

		local badOk, err = Value.decode({ t = "BrickColor", name = "Brihgt red" }, constructors())
		t.falsy(badOk, "a typo must not become Medium stone grey")
		t.contains(err, "Brihgt red")
	end)

	t.test("names the Enum family or member it could not find", function()
		local ok, value = Value.decode({ t = "Enum", enum = "Sample", value = "Member" }, constructors())
		t.truthy(ok)
		t.equal(value, "Enum.Sample.Member")

		local badOk, err = Value.decode({ t = "Enum", enum = "Sample", value = "Nope" }, constructors())
		t.falsy(badOk)
		t.contains(err, "Nope")
		t.contains(err, "Enum.Sample")
	end)

	t.test("refuses an InstanceRef with no resolver rather than assigning nil", function()
		local ok, err = Value.decode({ t = "InstanceRef", path = "Workspace.Part" }, constructors())
		t.falsy(ok)
		t.contains(err, "no instance resolver")
	end)

	t.test("resolves an InstanceRef through the injected resolver", function()
		local ctors = constructors()
		ctors.resolveRef = function(path)
			if path == "Workspace.Part" then
				return "the part", nil
			end
			return nil, "does not exist"
		end
		local ok, value = Value.decode({ t = "InstanceRef", path = "Workspace.Part" }, ctors)
		t.truthy(ok)
		t.equal(value, "the part")

		local badOk, err = Value.decode({ t = "InstanceRef", path = "Workspace.Gone" }, ctors)
		t.falsy(badOk)
		t.contains(err, "Workspace.Gone")
	end)

	t.test("encodes scalars back into the tagged union", function()
		local ok, encoded = Value.encode("hello")
		t.truthy(ok)
		t.equal(encoded.t, "String")
		t.equal(encoded.v, "hello")

		ok, encoded = Value.encode(nil)
		t.truthy(ok)
		t.equal(encoded.t, "Nil")

		ok, encoded = Value.encode(7)
		t.truthy(ok)
		t.equal(encoded.t, "Number")
	end)

	t.test("refuses to encode something the protocol cannot carry", function()
		local ok, err = Value.encode(function() end)
		t.falsy(ok)
		t.contains(err, "cannot carry")
	end)

	t.test("describes values for the diff without throwing", function()
		t.equal(Value.describe({ t = "Bool", v = true }), "true")
		t.contains(Value.describe({ t = "Vector3", x = 1, y = 2, z = 3 }), "Vector3(1, 2, 3)")
		t.equal(Value.describe({ t = "Nil" }), "nil")
		t.contains(Value.describe("not a value"), "malformed")
	end)
end
