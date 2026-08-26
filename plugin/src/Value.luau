--!strict
--[[
	Value — the protocol's tagged PropertyValue union, in both directions.

	Decoding is where a ChangeSet stops being JSON and becomes something that will
	be written into a real place, so it is the narrowest gate in the plugin:

	  * every tag is listed explicitly; an unknown tag is an error naming the tag
	    and never a guess. Guessing is how `Instance[property] = someTable` ends up
	    throwing halfway through an apply that the journal then has to unpick;
	  * every field is re-checked here even though the server validated it, because
	    "the server said so" is not a defence the plugin can offer to a user whose
	    place just changed shape.

	Constructors are injected rather than referenced directly so the decoder can be
	unit-tested outside Studio, where none of the Roblox datatypes exist.
]]

local Value = {}

--[[
	Roblox datatype globals, captured once. Outside Studio these are all nil and
	the table is simply empty — tests pass their own constructors instead.
]]
Value.RobloxConstructors = {
	Vector3 = Vector3,
	Vector2 = Vector2,
	Color3 = Color3,
	UDim = UDim,
	UDim2 = UDim2,
	Rect = Rect,
	CFrame = CFrame,
	BrickColor = BrickColor,
	Enum = Enum,
	ColorSequence = ColorSequence,
	ColorSequenceKeypoint = ColorSequenceKeypoint,
	NumberSequence = NumberSequence,
	NumberSequenceKeypoint = NumberSequenceKeypoint,
	NumberRange = NumberRange,
	Font = Font,
} :: any

-- Mirrors PROPERTY_VALUE_TAGS in packages/protocol/src/value.ts. Order is the
-- protocol's; it is only ever shown to a human in an error message.
Value.TAGS = table.freeze({
	"String", "Number", "Int", "Bool", "Nil",
	"Vector3", "Vector2", "Color3",
	"UDim", "UDim2", "Rect", "CFrame",
	"BrickColor", "Enum", "InstanceRef",
	"ColorSequence", "NumberSequence", "NumberRange", "Font",
})

local function isFiniteNumber(n: any): boolean
	return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function numberList(source: any, count: number, label: string): ({ number }?, string?)
	if type(source) ~= "table" then
		return nil, string.format("%s must be an array of %d numbers", label, count)
	end
	local out: { number } = {}
	for index = 1, count do
		local n = (source :: any)[index]
		if not isFiniteNumber(n) then
			return nil, string.format("%s[%d] must be a finite number", label, index)
		end
		out[index] = n
	end
	return out, nil
end

local function requireCtor(ctors: any, name: string): (any?, string?)
	local ctor = ctors[name]
	if ctor == nil then
		return nil, string.format("this runtime has no %s constructor", name)
	end
	return ctor, nil
end

type Decoder = (any, any) -> (boolean, any)

local decoders: { [string]: Decoder } = {}

decoders.String = function(v)
	if type(v.v) ~= "string" then
		return false, "String value must carry a string in `v`"
	end
	return true, v.v
end

decoders.Number = function(v)
	if not isFiniteNumber(v.v) then
		return false, "Number value must carry a finite number in `v`"
	end
	return true, v.v
end

decoders.Int = function(v)
	if not isFiniteNumber(v.v) or v.v % 1 ~= 0 then
		return false, "Int value must carry a whole number in `v`"
	end
	return true, v.v
end

decoders.Bool = function(v)
	if type(v.v) ~= "boolean" then
		return false, "Bool value must carry a boolean in `v`"
	end
	return true, v.v
end

decoders.Nil = function()
	return true, nil
end

decoders.Vector3 = function(v, ctors)
	local ctor, err = requireCtor(ctors, "Vector3")
	if not ctor then
		return false, err
	end
	if not (isFiniteNumber(v.x) and isFiniteNumber(v.y) and isFiniteNumber(v.z)) then
		return false, "Vector3 needs finite x, y and z"
	end
	return true, ctor.new(v.x, v.y, v.z)
end

decoders.Vector2 = function(v, ctors)
	local ctor, err = requireCtor(ctors, "Vector2")
	if not ctor then
		return false, err
	end
	if not (isFiniteNumber(v.x) and isFiniteNumber(v.y)) then
		return false, "Vector2 needs finite x and y"
	end
	return true, ctor.new(v.x, v.y)
end

decoders.Color3 = function(v, ctors)
	local ctor, err = requireCtor(ctors, "Color3")
	if not ctor then
		return false, err
	end
	for _, channel in { "r", "g", "b" } do
		local n = (v :: any)[channel]
		if not isFiniteNumber(n) or n < 0 or n > 1 then
			return false, string.format("Color3.%s must be between 0 and 1", channel)
		end
	end
	return true, ctor.new(v.r, v.g, v.b)
end

decoders.UDim = function(v, ctors)
	local ctor, err = requireCtor(ctors, "UDim")
	if not ctor then
		return false, err
	end
	if not isFiniteNumber(v.scale) or not isFiniteNumber(v.offset) then
		return false, "UDim needs finite scale and offset"
	end
	return true, ctor.new(v.scale, v.offset)
end

decoders.UDim2 = function(v, ctors)
	local ctor, err = requireCtor(ctors, "UDim2")
	if not ctor then
		return false, err
	end
	for _, field in { "xScale", "xOffset", "yScale", "yOffset" } do
		if not isFiniteNumber((v :: any)[field]) then
			return false, string.format("UDim2.%s must be a finite number", field)
		end
	end
	return true, ctor.new(v.xScale, v.xOffset, v.yScale, v.yOffset)
end

decoders.Rect = function(v, ctors)
	local ctor, err = requireCtor(ctors, "Rect")
	if not ctor then
		return false, err
	end
	for _, field in { "minX", "minY", "maxX", "maxY" } do
		if not isFiniteNumber((v :: any)[field]) then
			return false, string.format("Rect.%s must be a finite number", field)
		end
	end
	return true, ctor.new(v.minX, v.minY, v.maxX, v.maxY)
end

decoders.CFrame = function(v, ctors)
	local ctor, err = requireCtor(ctors, "CFrame")
	if not ctor then
		return false, err
	end
	local position, positionErr = numberList(v.position, 3, "CFrame.position")
	if not position then
		return false, positionErr
	end
	-- Row-major, matching the protocol. The 12-argument CFrame constructor takes
	-- its rotation components in the same order, so this is a straight hand-off:
	-- reordering here would silently rotate every model this plugin ever places.
	local rotation, rotationErr = numberList(v.rotation, 9, "CFrame.rotation")
	if not rotation then
		return false, rotationErr
	end
	return true,
		ctor.new(
			position[1], position[2], position[3],
			rotation[1], rotation[2], rotation[3],
			rotation[4], rotation[5], rotation[6],
			rotation[7], rotation[8], rotation[9]
		)
end

decoders.BrickColor = function(v, ctors)
	local ctor, err = requireCtor(ctors, "BrickColor")
	if not ctor then
		return false, err
	end
	if type(v.name) ~= "string" or v.name == "" then
		return false, "BrickColor needs a name"
	end
	local ok, colour = pcall(ctor.new, v.name)
	if not ok or colour == nil then
		return false, string.format('"%s" is not a BrickColor name', v.name)
	end
	-- BrickColor.new falls back to a default colour for an unknown name rather
	-- than erroring, so the only way to catch a typo is to check what came back.
	if colour.Name ~= v.name then
		return false, string.format('"%s" is not a BrickColor name', v.name)
	end
	return true, colour
end

decoders.Enum = function(v, ctors)
	local root, err = requireCtor(ctors, "Enum")
	if not root then
		return false, err
	end
	if type(v.enum) ~= "string" or type(v.value) ~= "string" then
		return false, "Enum needs `enum` and `value` names"
	end
	local okFamily, family = pcall(function()
		return root[v.enum]
	end)
	if not okFamily or family == nil then
		return false, string.format('"%s" is not an Enum family', v.enum)
	end
	local okMember, member = pcall(function()
		return family[v.value]
	end)
	if not okMember or member == nil then
		return false, string.format('"%s" is not a member of Enum.%s', v.value, v.enum)
	end
	return true, member
end

decoders.InstanceRef = function(v, ctors)
	if type(v.path) ~= "string" or v.path == "" then
		return false, "InstanceRef needs a path"
	end
	local resolve = ctors.resolveRef
	if type(resolve) ~= "function" then
		return false, "InstanceRef cannot be decoded here: no instance resolver was provided"
	end
	local target, resolveErr = resolve(v.path)
	if target == nil then
		return false, string.format("InstanceRef %s could not be resolved: %s", v.path, resolveErr or "not found")
	end
	return true, target
end

decoders.ColorSequence = function(v, ctors)
	local ctor, err = requireCtor(ctors, "ColorSequence")
	if not ctor then
		return false, err
	end
	local keypointCtor, keypointErr = requireCtor(ctors, "ColorSequenceKeypoint")
	if not keypointCtor then
		return false, keypointErr
	end
	local colourCtor, colourErr = requireCtor(ctors, "Color3")
	if not colourCtor then
		return false, colourErr
	end
	if type(v.keypoints) ~= "table" or #v.keypoints < 2 then
		return false, "ColorSequence needs at least two keypoints"
	end
	local keypoints = {}
	for index, keypoint in v.keypoints do
		if not isFiniteNumber(keypoint.time) then
			return false, string.format("ColorSequence keypoint %d needs a time", index)
		end
		keypoints[index] = keypointCtor.new(keypoint.time, colourCtor.new(keypoint.r, keypoint.g, keypoint.b))
	end
	local ok, sequence = pcall(ctor.new, keypoints)
	if not ok then
		return false, "ColorSequence keypoints must run from time 0 to time 1 in order"
	end
	return true, sequence
end

decoders.NumberSequence = function(v, ctors)
	local ctor, err = requireCtor(ctors, "NumberSequence")
	if not ctor then
		return false, err
	end
	local keypointCtor, keypointErr = requireCtor(ctors, "NumberSequenceKeypoint")
	if not keypointCtor then
		return false, keypointErr
	end
	if type(v.keypoints) ~= "table" or #v.keypoints < 2 then
		return false, "NumberSequence needs at least two keypoints"
	end
	local keypoints = {}
	for index, keypoint in v.keypoints do
		if not isFiniteNumber(keypoint.time) or not isFiniteNumber(keypoint.value) then
			return false, string.format("NumberSequence keypoint %d needs a time and a value", index)
		end
		keypoints[index] = keypointCtor.new(keypoint.time, keypoint.value, keypoint.envelope or 0)
	end
	local ok, sequence = pcall(ctor.new, keypoints)
	if not ok then
		return false, "NumberSequence keypoints must run from time 0 to time 1 in order"
	end
	return true, sequence
end

decoders.NumberRange = function(v, ctors)
	local ctor, err = requireCtor(ctors, "NumberRange")
	if not ctor then
		return false, err
	end
	if not isFiniteNumber(v.min) or not isFiniteNumber(v.max) then
		return false, "NumberRange needs finite min and max"
	end
	if v.min > v.max then
		return false, "NumberRange min is greater than max"
	end
	return true, ctor.new(v.min, v.max)
end

decoders.Font = function(v, ctors)
	local ctor, err = requireCtor(ctors, "Font")
	if not ctor then
		return false, err
	end
	local root, enumErr = requireCtor(ctors, "Enum")
	if not root then
		return false, enumErr
	end
	if type(v.family) ~= "string" or v.family == "" then
		return false, "Font needs a family"
	end
	local weightName = if type(v.weight) == "string" then v.weight else "Regular"
	local styleName = if type(v.style) == "string" then v.style else "Normal"
	local okWeight, weight = pcall(function()
		return root.FontWeight[weightName]
	end)
	if not okWeight or weight == nil then
		return false, string.format('"%s" is not a FontWeight', weightName)
	end
	local okStyle, style = pcall(function()
		return root.FontStyle[styleName]
	end)
	if not okStyle or style == nil then
		return false, string.format('"%s" is not a FontStyle', styleName)
	end
	return true, ctor.new(v.family, weight, style)
end

--[[
	Decode one tagged PropertyValue.

	Returns (true, decoded) or (false, message). `Nil` decodes to (true, nil),
	which is why the boolean is the discriminator and not the value itself.
]]
function Value.decode(value: any, ctors: any?): (boolean, any)
	if type(value) ~= "table" then
		return false, "PropertyValue must be an object with a `t` tag"
	end
	local tag = value.t
	if type(tag) ~= "string" then
		return false, "PropertyValue is missing its `t` tag"
	end
	local decoder = decoders[tag]
	if not decoder then
		return false,
			string.format(
				'unknown PropertyValue tag "%s" — this plugin understands: %s',
				tag,
				table.concat(Value.TAGS, ", ")
			)
	end
	return decoder(value, ctors or Value.RobloxConstructors)
end

--[[
	Encode a live Roblox value back into the tagged union, for the journal's
	`restoreProperty.previous`. Only what can be re-decoded is emitted: an
	unencodable value returns false so the caller refuses the operation rather
	than applying something it cannot reverse.

	Note that Int and Number both arrive here as Luau numbers and the distinction
	is unrecoverable. Everything is emitted as Number; both tags decode to the
	same Luau number, so a restore is unaffected.
]]
function Value.encode(value: any, options: any?): (boolean, any)
	local opts: any = options or {}
	local typeName: string = (opts.typeofFn or typeof or type)(value)

	if value == nil then
		return true, { t = "Nil" }
	elseif typeName == "string" then
		return true, { t = "String", v = value }
	elseif typeName == "number" then
		if value ~= value or value == math.huge or value == -math.huge then
			return false, "property holds a non-finite number, which the protocol cannot carry"
		end
		return true, { t = "Number", v = value }
	elseif typeName == "boolean" then
		return true, { t = "Bool", v = value }
	elseif typeName == "Vector3" then
		return true, { t = "Vector3", x = value.X, y = value.Y, z = value.Z }
	elseif typeName == "Vector2" then
		return true, { t = "Vector2", x = value.X, y = value.Y }
	elseif typeName == "Color3" then
		return true, { t = "Color3", r = value.R, g = value.G, b = value.B }
	elseif typeName == "UDim" then
		return true, { t = "UDim", scale = value.Scale, offset = value.Offset }
	elseif typeName == "UDim2" then
		return true,
			{
				t = "UDim2",
				xScale = value.X.Scale,
				xOffset = value.X.Offset,
				yScale = value.Y.Scale,
				yOffset = value.Y.Offset,
			}
	elseif typeName == "Rect" then
		return true,
			{ t = "Rect", minX = value.Min.X, minY = value.Min.Y, maxX = value.Max.X, maxY = value.Max.Y }
	elseif typeName == "CFrame" then
		local px, py, pz, r00, r01, r02, r10, r11, r12, r20, r21, r22 = value:GetComponents()
		return true,
			{
				t = "CFrame",
				position = { px, py, pz },
				rotation = { r00, r01, r02, r10, r11, r12, r20, r21, r22 },
			}
	elseif typeName == "BrickColor" then
		return true, { t = "BrickColor", name = value.Name }
	elseif typeName == "EnumItem" then
		return true, { t = "Enum", enum = tostring(value.EnumType), value = value.Name }
	elseif typeName == "NumberRange" then
		return true, { t = "NumberRange", min = value.Min, max = value.Max }
	elseif typeName == "Font" then
		return true,
			{ t = "Font", family = value.Family, weight = value.Weight.Name, style = value.Style.Name }
	elseif typeName == "ColorSequence" then
		local keypoints = {}
		for index, keypoint in value.Keypoints do
			keypoints[index] = {
				time = keypoint.Time,
				r = keypoint.Value.R,
				g = keypoint.Value.G,
				b = keypoint.Value.B,
			}
		end
		return true, { t = "ColorSequence", keypoints = keypoints }
	elseif typeName == "NumberSequence" then
		local keypoints = {}
		for index, keypoint in value.Keypoints do
			keypoints[index] = { time = keypoint.Time, value = keypoint.Value, envelope = keypoint.Envelope }
		end
		return true, { t = "NumberSequence", keypoints = keypoints }
	elseif typeName == "Instance" then
		local path = opts.pathOf and opts.pathOf(value) or nil
		if type(path) ~= "string" then
			return false, "property references an instance outside any addressable service root"
		end
		return true, { t = "InstanceRef", path = path }
	end

	return false, string.format("property holds a %s, which the protocol cannot carry", typeName)
end

--- A short human-readable rendering of a tagged value, for the diff.
function Value.describe(value: any): string
	if type(value) ~= "table" or type(value.t) ~= "string" then
		return "<malformed value>"
	end
	local tag = value.t
	if tag == "Nil" then
		return "nil"
	elseif tag == "String" then
		local text = tostring(value.v)
		if #text > 60 then
			return string.format("%q…", string.sub(text, 1, 60))
		end
		return string.format("%q", text)
	elseif tag == "Number" or tag == "Int" then
		return tostring(value.v)
	elseif tag == "Bool" then
		return tostring(value.v)
	elseif tag == "Vector3" then
		return string.format("Vector3(%.3g, %.3g, %.3g)", value.x, value.y, value.z)
	elseif tag == "Vector2" then
		return string.format("Vector2(%.3g, %.3g)", value.x, value.y)
	elseif tag == "Color3" then
		return string.format("Color3(%.3g, %.3g, %.3g)", value.r, value.g, value.b)
	elseif tag == "UDim" then
		return string.format("UDim(%.3g, %d)", value.scale, value.offset)
	elseif tag == "UDim2" then
		return string.format("UDim2(%.3g, %d, %.3g, %d)", value.xScale, value.xOffset, value.yScale, value.yOffset)
	elseif tag == "Rect" then
		return string.format("Rect(%.3g, %.3g, %.3g, %.3g)", value.minX, value.minY, value.maxX, value.maxY)
	elseif tag == "CFrame" then
		local p = value.position or {}
		return string.format("CFrame at (%.3g, %.3g, %.3g)", p[1] or 0, p[2] or 0, p[3] or 0)
	elseif tag == "BrickColor" then
		return string.format("BrickColor(%s)", tostring(value.name))
	elseif tag == "Enum" then
		return string.format("Enum.%s.%s", tostring(value.enum), tostring(value.value))
	elseif tag == "InstanceRef" then
		return string.format("→ %s", tostring(value.path))
	elseif tag == "NumberRange" then
		return string.format("NumberRange(%.3g, %.3g)", value.min, value.max)
	elseif tag == "Font" then
		return string.format("Font(%s, %s)", tostring(value.family), tostring(value.weight))
	elseif tag == "ColorSequence" or tag == "NumberSequence" then
		local count = if type(value.keypoints) == "table" then #value.keypoints else 0
		return string.format("%s with %d keypoints", tag, count)
	end
	return string.format("<%s>", tag)
end

return Value
