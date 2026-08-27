--!strict
--[[
	Approve — the human gate, and the policy that decides whether it is needed.

	ADR-012 in two halves:

	  * `Approve.evaluate` is the policy. Approval is required by default; auto-apply
	    is opt-in, scoped to a path prefix, and NEVER covers deleteInstance. That
	    last rule is unconditional — no setting, no scope and no validation verdict
	    turns it off, because a deletion is the one operation whose cost is not
	    obvious from the diff;
	  * a ChangeSet's `validation` is a claim from the other end of the link, not
	    something this plugin computed, so it is advisory: it may add a reason to
	    ask a human and it may never remove one. Anything that writes Luau source
	    therefore goes to a human, because static analysis is the part of the
	    verdict this plugin has no way to recompute;
	  * `Approve.mount` is the widget. It shows the privacy posture in words rather
	    than a padlock, the summary, whose verdict it is showing, every reason the
	    set was held for a human, the destructive operations first, and then the
	    diff. Approval is meant to be a glance, not an audit — but a glance at
	    "approve or reject" with no "why" is not approval, it is assent.

	`evaluate` is pure and has tests. The widget is deliberately dumb: it renders
	what it is handed and calls back.
]]

local Approve = {}

export type Policy = {
	autoApply: boolean,
	scope: string,
	bulkDeleteThreshold: number?,
}

--[[
	What the ChangeSet claims about its own validation.

	Reported to the user with its origin attached, never used to grant anything:
	this is a claim that arrived over the wire, not a verdict this plugin
	computed. `present` is false when the set carried no verdict at all.
]]
export type ValidationView = {
	present: boolean,
	origin: string?,
	luau: string?,
	policy: string?,
}

export type Decision = {
	auto: boolean,
	blockers: { string },
	warnings: { string },
	validation: ValidationView,
}

--[[
	Every path an operation touches, mirroring `pathsOf` in
	`packages/protocol/src/operation.ts` — including the ones that appear only
	inside property *values*.

	An `InstanceRef` in a property bag names another instance, and the auto-apply
	scope has to see it: a ChangeSet confined to an allowed prefix can still wire
	a reference at something well outside it. Returning only `operation.path`
	meant this scope gate walked a list missing exactly the paths a model picks
	freely, and the core closed the same hole in `pathsOf`.
]]
local function refPathOf(value: any): string?
	if type(value) == "table" and value.t == "InstanceRef" and type(value.path) == "string" then
		return value.path
	end
	return nil
end

local function touchedPaths(operation: any): { string }
	local paths = { operation.path }

	if operation.op == "moveInstance" then
		table.insert(paths, operation.to)
	elseif operation.op == "setProperty" then
		local ref = refPathOf(operation.value)
		if ref then
			table.insert(paths, ref)
		end
	elseif operation.op == "createInstance" then
		for _, value in operation.properties or {} do
			local ref = refPathOf(value)
			if ref then
				table.insert(paths, ref)
			end
		end
	end

	return paths
end

--[[
	Does this operation put Luau source into the place?

	Static analysis of that source is the one part of a validation verdict this
	plugin cannot recompute: there is no Luau parser in this plugin to replace it
	with. `packages/luau-analysis` does recompute it now, on the daemon, and a
	`fail` from it never reaches here — but that analyser reads what a script
	says rather than what it computes, and this plugin cannot tell a verdict it
	witnessed from one a sender wrote. So an operation carrying source is an
	operation whose safety rests on a check this plugin did not perform, and that
	goes to a human regardless of how clean the verdict looks.

	Detected by content rather than by op: `createInstance` of a script class with
	a `Source` in its property bag, and a `setProperty` writing `Source`, put code
	in the place exactly as much as `writeScript` does.
]]
local function carriesSource(operation: any): boolean
	if operation.op == "writeScript" then
		return true
	end
	if operation.op == "setProperty" then
		return operation.property == "Source"
	end
	if operation.op == "createInstance" then
		return (operation.properties or {}).Source ~= nil
	end
	return false
end

--[[
	The properties that can start code already sitting in the place.

	Mirrors `ACTIVATING_PROPERTIES` in `packages/protocol/src/operation.ts`, which
	is what `activatesExistingCode` is built from and which this plugin cannot
	import — Roblox's Instance-based `require` puts a TypeScript package out of
	reach, so the protocol's list is restated here and the restatement is the thing
	that can go wrong. It already had: this table read `Disabled` and `RunContext`
	and not `Enabled`, so `setProperty` of `Enabled` on a Script inside the
	auto-apply scope started dormant code with no analysis and no human — the exact
	hole the protocol added `activatesExistingCode` to close.

	The value maps each property to the ONE value that provably stops code, which
	is the only shape that may be waved through. Everything else blocks, including
	a value this function cannot read: unreadable is not safe.

	  * `Disabled` = `Bool true` disables the script whatever state it was in, so
	    it can never start anything. `Bool false` starts it.
	  * `Enabled` = `Bool false` is the same statement the other way round. It is
	    the property that was missing, and it is missing from nothing else now
	    because this table is the whole rule.
	  * `RunContext` has no such value at all, and that is `false` below rather
	    than an omission: `Server` or `Client` makes a Script run where it sits,
	    including in a container that has never run one, and `evaluate` holds the
	    ChangeSet and nothing else — no DataModel, so no way to read what the
	    instance's RunContext is now, and therefore no way to tell a write that
	    stops a script from one that starts it.
]]
local ACTIVATING_PROPERTIES: { [string]: any } = table.freeze({
	Disabled = { t = "Bool", v = true },
	Enabled = { t = "Bool", v = false },
	RunContext = false,
})

--[[
	Does this operation take the brake off code that is ALREADY in the place?

	`carriesSource` catches an operation that INSTALLS code. This is the other
	half of the same risk: an operation that installs nothing and merely starts a
	script already sitting inside the auto-apply scope. No Luau rides along in the
	ChangeSet, so there is no source for any verdict to be about and nothing for
	this plugin to weigh — the diff reads as a one-line property write, and the
	consequence is a script running. ADR-012 makes approval the safety mechanism
	and auto-apply a narrow, scoped exception; starting dormant code is as
	consequential as installing it, so it belongs to the human either way.

	Returns the property responsible, so the blocker can name it.

	Deliberately not `moveInstance`: a move carries no class, so this could not
	tell a Script being reparented from a Part being tidied, and a rule that fires
	on every ordinary reparent is one people learn to click through. A move stays
	a warning, and it is rendered in the diff.
]]
local function startsDormantCode(operation: any): string?
	if operation.op ~= "setProperty" then
		return nil
	end
	local stopper = ACTIVATING_PROPERTIES[tostring(operation.property)]
	if stopper == nil then
		return nil
	end
	if stopper == false then
		-- No value of this property is a stop. It blocks whatever it is set to.
		return operation.property
	end
	local value = operation.value
	local stopsCode = type(value) == "table" and value.t == stopper.t and value.v == stopper.v
	return if stopsCode then nil else operation.property
end

--[[
	Decide whether this ChangeSet may skip the human.

	Every reason it may not is collected rather than short-circuited: a user who
	turns auto-apply on and still sees the dialog deserves to be told all of why.

	The governing rule is that auto-apply may rest only on things this plugin
	checked itself — the path scope, the operation kinds, the presence of code.
	`changeSet.validation` is a claim made by whoever sent the set, and
	`packages/protocol/src/changeset.ts` is explicit that a consumer must treat a
	verdict it did not witness as unvalidated. So the verdict is advisory, and
	advisory here means one-directional: it can add a blocker (a reported `fail`
	is still worth refusing on) and it can never remove one. An `ok` unlocks
	nothing at all.
]]
function Approve.evaluate(changeSet: any, policy: Policy, isWithin: (string, string) -> boolean): Decision
	local blockers: { string } = {}
	local warnings: { string } = {}

	local deletions = 0
	local moves = 0
	local sourceWrites = 0
	local codeStarts = 0
	-- The properties responsible, in the order they first appear and without
	-- repeats: the blocker names them, and "(Disabled, Disabled, Disabled)" tells
	-- a reader nothing the count did not already say.
	local startProperties: { string } = {}
	local seenStartProperty: { [string]: boolean } = {}
	for _, operation in changeSet.operations or {} do
		if operation.op == "deleteInstance" then
			deletions += 1
		elseif operation.op == "moveInstance" then
			moves += 1
		end
		if carriesSource(operation) then
			sourceWrites += 1
		end
		local startProperty = startsDormantCode(operation)
		if startProperty then
			codeStarts += 1
			if not seenStartProperty[startProperty] then
				seenStartProperty[startProperty] = true
				table.insert(startProperties, startProperty)
			end
		end
	end

	if deletions > 0 then
		-- Unconditional (ADR-012). Checked before the autoApply flag so the reason
		-- shown is the real one.
		table.insert(blockers, string.format("%d deletion(s) — deleteInstance is never auto-applied", deletions))
	end

	local threshold = policy.bulkDeleteThreshold or 10
	if deletions > threshold then
		table.insert(warnings, string.format("this set deletes %d instances, over the bulk threshold of %d", deletions, threshold))
	end
	if moves > 0 then
		table.insert(warnings, string.format("%d instance(s) move to a new parent", moves))
	end

	if sourceWrites > 0 then
		-- The only thing vouching for that source is a verdict this plugin did not
		-- compute, so it is a human's call however the verdict reads.
		table.insert(
			blockers,
			string.format(
				"%d operation(s) write Luau source, and only a validation verdict this plugin did not compute vouches for it",
				sourceWrites
			)
		)
	end

	if codeStarts > 0 then
		-- The source that would run is not in this ChangeSet, so no verdict — not
		-- even one this plugin had computed itself — could be about it.
		table.insert(
			blockers,
			string.format(
				"%d operation(s) can start code that is already in the place (%s) — that code is in no ChangeSet, so nothing has vouched for it at all",
				codeStarts,
				table.concat(startProperties, ", ")
			)
		)
	end

	if not policy.autoApply then
		table.insert(blockers, "auto-apply is off")
	end

	local validation = changeSet.validation
	local view: ValidationView = { present = false }
	if type(validation) ~= "table" then
		-- A consumer must treat a ChangeSet whose validation it did not witness as
		-- unvalidated (packages/protocol/src/changeset.ts). No verdict at all means
		-- nothing looked at this set anywhere, which is worth refusing on its own.
		table.insert(blockers, "this ChangeSet carries no validation verdict")
	else
		local luau = validation.luau or {}
		local rules = validation.policy or {}
		view = {
			present = true,
			origin = if type(validation.computedBy) == "string" and validation.computedBy ~= ""
				then validation.computedBy
				else "an unnamed producer",
			luau = if type(luau.status) == "string" then luau.status else "unreported",
			policy = if type(rules.status) == "string" then rules.status else "unreported",
		}
		-- Said out loud rather than implied by a green tick: the user is looking at
		-- someone else's claim, and the panel names whose.
		table.insert(
			warnings,
			string.format(
				'the validation verdict was computed by "%s" — this plugin cannot verify it and treats it as advisory',
				tostring(view.origin)
			)
		)
		if luau.status == "fail" then
			table.insert(blockers, "static analysis of the Luau failed")
		elseif luau.status == "warn" then
			local count = if type(luau.findings) == "table" then #luau.findings else 0
			table.insert(warnings, string.format("static analysis raised %d finding(s)", count))
		end
		if rules.status == "fail" then
			local violations = if type(rules.violations) == "table" then #rules.violations else 0
			table.insert(blockers, string.format("policy check failed with %d violation(s)", violations))
		end
	end

	local scope = policy.scope
	if policy.autoApply then
		if type(scope) ~= "string" or scope == "" then
			table.insert(blockers, "auto-apply has no path scope set")
		else
			for _, operation in changeSet.operations or {} do
				for _, path in touchedPaths(operation) do
					if not isWithin(path, scope) then
						table.insert(blockers, string.format('"%s" is outside the auto-apply scope "%s"', path, scope))
					end
				end
			end
		end
	end

	return { auto = #blockers == 0, blockers = blockers, warnings = warnings, validation = view }
end

--[[
	One line naming the verdict and whose it is.

	Pure, so it has a test. It never renders a verdict without its origin: a bare
	"validation: ok" would read as this plugin's finding, and this plugin has not
	found anything — it is repeating what the other end of the link said.
]]
function Approve.describeValidation(view: ValidationView?): string
	if type(view) ~= "table" or not view.present then
		return "Validation: none reported with this ChangeSet"
	end
	return string.format(
		'Validation (reported by "%s", not verified here): Luau %s · policy %s',
		tostring(view.origin),
		tostring(view.luau),
		tostring(view.policy)
	)
end

--[[
	The note block above the diff: why this ChangeSet stopped here, and then what
	is merely worth knowing.

	This is the WHOLE of that block — `Widget:present` assigns the string this
	returns and adds nothing of its own — so a test on this function is a test on
	the text a person reads. That matters here specifically: `evaluate` was
	computing `blockers` and the panel rendered only `warnings`, so a person was
	shown Approve and Reject with every carefully worded reason dropped on the
	floor. Blockers lead, because "why am I being asked?" is the question a
	reviewer is actually holding.

	Pure, and it has to stay that way. The unit tests run in a plain Luau where the
	Roblox globals do not exist and the global table is readonly, so the widget
	itself cannot be driven there — a function that returns the exact words is the
	only place the panel's text can be asserted against.
]]
function Approve.describeNotes(decision: Decision?, instancesDestroyed: number?): string
	local lines: { string } = {}

	local blockers = if type(decision) == "table" and type((decision :: any).blockers) == "table"
		then (decision :: any).blockers
		else {}
	if #blockers > 0 then
		table.insert(lines, string.format("Approval required — %d reason(s):", #blockers))
		for _, blocker in blockers do
			table.insert(lines, "  · " .. tostring(blocker))
		end
	end

	local warnings = if type(decision) == "table" and type((decision :: any).warnings) == "table"
		then (decision :: any).warnings
		else {}
	for _, warning in warnings do
		table.insert(lines, "! " .. tostring(warning))
	end

	if instancesDestroyed and instancesDestroyed > 0 then
		table.insert(lines, string.format("! %d instances would be destroyed", instancesDestroyed))
	end

	return table.concat(lines, "\n")
end

-- ── widget ────────────────────────────────────────────────────────────────────

-- RGB triples rather than Color3 values: nothing Roblox-specific may be touched
-- at module scope, or `Approve.evaluate` could not be unit-tested outside Studio.
local FALLBACK_COLOURS = table.freeze({
	MainBackground = { 46, 46, 46 },
	MainText = { 255, 255, 255 },
	SubText = { 170, 170, 170 },
	Border = { 34, 34, 34 },
	InputFieldBackground = { 37, 37, 37 },
	ScriptBackground = { 31, 31, 31 },
	ErrorText = { 255, 92, 92 },
	WarningText = { 255, 184, 77 },
	DialogMainButton = { 0, 122, 204 },
	DialogMainButtonText = { 255, 255, 255 },
	DialogButton = { 60, 60, 60 },
})

local function colour(theme: any, token: string): Color3
	if theme then
		local ok, value = pcall(function()
			return theme:GetColor((Enum.StudioStyleGuideColor :: any)[token])
		end)
		if ok and value then
			return value
		end
	end
	local rgb = (FALLBACK_COLOURS :: any)[token] or FALLBACK_COLOURS.MainText
	return Color3.fromRGB(rgb[1], rgb[2], rgb[3])
end

local function create(className: string, properties: any, children: { any }?): any
	local instance = Instance.new(className)
	for key, value in properties do
		(instance :: any)[key] = value
	end
	local descendants: { any } = children or {}
	for _, child in descendants do
		child.Parent = instance
	end
	return instance
end

local Widget = {}
Widget.__index = Widget

export type MountOptions = {
	gui: any, -- a DockWidgetPluginGui
	theme: any?,
	onApprove: () -> (),
	onReject: () -> (),
	onSettingsChanged: (any) -> (),
	--[[
		(baseUrl, pairingCode). The code is whatever the user typed, normalised; an
		empty string means "connect with the link already stored", which is the
		ordinary case after a Studio restart.
	]]
	onConnect: (string, string) -> (),
	--[[
		`Crypto.normalisePairingCode`, passed in because this widget is a leaf and
		requires nothing. Used only to show the user the form of the code that will
		be sent — the normalisation that matters happens again inside `Pairing.pair`,
		where it is not optional and where the key is derived from its result.
	]]
	normalisePairingCode: ((string) -> string)?,
}

--[[
	Build the widget. Returns a controller the caller drives; the widget never
	reaches back into the transport or the applier itself.
]]
function Approve.mount(options: MountOptions): any
	local theme = options.theme
	local gui = options.gui

	local root = create("Frame", {
		Name = "ForgeBridge",
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = colour(theme, "MainBackground"),
		BorderSizePixel = 0,
	})

	local layout = create("UIListLayout", {
		Padding = UDim.new(0, 8),
		SortOrder = Enum.SortOrder.LayoutOrder,
	})
	layout.Parent = root
	create("UIPadding", {
		PaddingLeft = UDim.new(0, 10),
		PaddingRight = UDim.new(0, 10),
		PaddingTop = UDim.new(0, 10),
		PaddingBottom = UDim.new(0, 10),
	}).Parent = root

	local function label(text: string, size: number, token: string, order: number, monospace: boolean?): any
		return create("TextLabel", {
			Text = text,
			LayoutOrder = order,
			Font = if monospace then Enum.Font.Code else Enum.Font.SourceSans,
			TextSize = size,
			TextColor3 = colour(theme, token),
			TextXAlignment = Enum.TextXAlignment.Left,
			TextWrapped = true,
			BackgroundTransparency = 1,
			Size = UDim2.new(1, 0, 0, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
		})
	end

	local stateLabel = label("Not connected", 15, "MainText", 1)
	stateLabel.Parent = root

	-- The posture is a sentence, never an icon. On a relay link the operator can
	-- read the changes, and a padlock would say the opposite (ADR-014).
	local postureLabel = label("No daemon configured", 13, "SubText", 2)
	postureLabel.Parent = root

	local urlBox = create("TextBox", {
		Size = UDim2.new(1, -178, 0, 26),
		PlaceholderText = "http://127.0.0.1:<daemon port>",
		Text = "",
		ClearTextOnFocus = false,
		Font = Enum.Font.Code,
		TextSize = 13,
		TextColor3 = colour(theme, "MainText"),
		BackgroundColor3 = colour(theme, "InputFieldBackground"),
		BorderColor3 = colour(theme, "Border"),
		TextXAlignment = Enum.TextXAlignment.Left,
	})
	create("UIPadding", { PaddingLeft = UDim.new(0, 6), PaddingRight = UDim.new(0, 6) }).Parent = urlBox

	--[[
		The pairing code, beside the address it pairs with.

		The daemon prints an eight-character code in its terminal and the user carries
		it here by hand; without it the daemon has no key for this link and refuses
		every poll. It sits next to the URL because the two are one action — an
		address alone was a Connect button that could never finish connecting.

		`ClearTextOnFocus` is off for the same reason it is off on the URL: a user
		correcting one character of a transcribed code should not lose the other
		seven.
	]]
	local codeBox = create("TextBox", {
		Size = UDim2.new(0, 96, 0, 26),
		Position = UDim2.new(1, -172, 0, 0),
		PlaceholderText = "pairing code",
		Text = "",
		ClearTextOnFocus = false,
		Font = Enum.Font.Code,
		TextSize = 13,
		TextColor3 = colour(theme, "MainText"),
		BackgroundColor3 = colour(theme, "InputFieldBackground"),
		BorderColor3 = colour(theme, "Border"),
		TextXAlignment = Enum.TextXAlignment.Left,
	})
	create("UIPadding", { PaddingLeft = UDim.new(0, 6), PaddingRight = UDim.new(0, 6) }).Parent = codeBox

	local connectButton = create("TextButton", {
		Size = UDim2.new(0, 70, 0, 26),
		Position = UDim2.new(1, -70, 0, 0),
		Text = "Connect",
		Font = Enum.Font.SourceSansSemibold,
		TextSize = 14,
		TextColor3 = colour(theme, "DialogMainButtonText"),
		BackgroundColor3 = colour(theme, "DialogMainButton"),
		BorderSizePixel = 0,
	})

	local urlRow = create("Frame", {
		LayoutOrder = 3,
		Size = UDim2.new(1, 0, 0, 26),
		BackgroundTransparency = 1,
	}, { urlBox, codeBox, connectButton })
	urlRow.Parent = root

	local autoApplyToggle = create("TextButton", {
		Size = UDim2.new(0, 130, 0, 24),
		Text = "Auto-apply: off",
		Font = Enum.Font.SourceSans,
		TextSize = 13,
		TextColor3 = colour(theme, "MainText"),
		BackgroundColor3 = colour(theme, "DialogButton"),
		BorderSizePixel = 0,
	})
	local scopeBox = create("TextBox", {
		Size = UDim2.new(1, -138, 0, 24),
		Position = UDim2.new(0, 138, 0, 0),
		PlaceholderText = "scope, e.g. ServerScriptService.Shop",
		Text = "",
		ClearTextOnFocus = false,
		Font = Enum.Font.Code,
		TextSize = 13,
		TextColor3 = colour(theme, "MainText"),
		BackgroundColor3 = colour(theme, "InputFieldBackground"),
		BorderColor3 = colour(theme, "Border"),
		TextXAlignment = Enum.TextXAlignment.Left,
	})
	create("UIPadding", { PaddingLeft = UDim.new(0, 6), PaddingRight = UDim.new(0, 6) }).Parent = scopeBox

	local policyRow = create("Frame", {
		LayoutOrder = 4,
		Size = UDim2.new(1, 0, 0, 24),
		BackgroundTransparency = 1,
	}, { autoApplyToggle, scopeBox })
	policyRow.Parent = root

	local mirrorToggle = create("TextButton", {
		LayoutOrder = 5,
		Size = UDim2.new(1, 0, 0, 24),
		Text = "Mirror Studio console to the producer: off",
		Font = Enum.Font.SourceSans,
		TextSize = 13,
		TextColor3 = colour(theme, "MainText"),
		BackgroundColor3 = colour(theme, "DialogButton"),
		BorderSizePixel = 0,
		TextXAlignment = Enum.TextXAlignment.Center,
	})
	mirrorToggle.Parent = root

	local summaryLabel = label("Waiting for a ChangeSet.", 14, "MainText", 6)
	summaryLabel.Parent = root

	-- Its own line, next to the summary, because the verdict is evidence the user
	-- is being asked to weigh and it always carries whose evidence it is.
	local validationLabel = label("", 13, "SubText", 7)
	validationLabel.Visible = false
	validationLabel.Parent = root

	local warningLabel = label("", 13, "WarningText", 8)
	warningLabel.Visible = false
	warningLabel.Parent = root

	local diffFrame = create("ScrollingFrame", {
		LayoutOrder = 9,
		Size = UDim2.new(1, 0, 1, -180),
		BackgroundColor3 = colour(theme, "ScriptBackground"),
		BorderColor3 = colour(theme, "Border"),
		CanvasSize = UDim2.new(),
		AutomaticCanvasSize = Enum.AutomaticSize.Y,
		ScrollBarThickness = 6,
	})
	create("UIListLayout", { Padding = UDim.new(0, 2), SortOrder = Enum.SortOrder.LayoutOrder }).Parent = diffFrame
	create("UIPadding", {
		PaddingLeft = UDim.new(0, 6),
		PaddingRight = UDim.new(0, 6),
		PaddingTop = UDim.new(0, 6),
		PaddingBottom = UDim.new(0, 6),
	}).Parent = diffFrame
	diffFrame.Parent = root

	local rejectButton = create("TextButton", {
		Size = UDim2.new(0.5, -4, 1, 0),
		Text = "Reject",
		Font = Enum.Font.SourceSansSemibold,
		TextSize = 15,
		TextColor3 = colour(theme, "MainText"),
		BackgroundColor3 = colour(theme, "DialogButton"),
		BorderSizePixel = 0,
		Visible = false,
	})
	local approveButton = create("TextButton", {
		Size = UDim2.new(0.5, -4, 1, 0),
		Position = UDim2.new(0.5, 4, 0, 0),
		Text = "Approve and apply",
		Font = Enum.Font.SourceSansSemibold,
		TextSize = 15,
		TextColor3 = colour(theme, "DialogMainButtonText"),
		BackgroundColor3 = colour(theme, "DialogMainButton"),
		BorderSizePixel = 0,
		Visible = false,
	})
	local buttonRow = create("Frame", {
		LayoutOrder = 10,
		Size = UDim2.new(1, 0, 0, 30),
		BackgroundTransparency = 1,
	}, { rejectButton, approveButton })
	buttonRow.Parent = root

	root.Parent = gui

	local self = setmetatable({
		gui = gui,
		theme = theme,
		root = root,
		stateLabel = stateLabel,
		postureLabel = postureLabel,
		urlBox = urlBox,
		codeBox = codeBox,
		normalisePairingCode = options.normalisePairingCode,
		scopeBox = scopeBox,
		autoApplyToggle = autoApplyToggle,
		mirrorToggle = mirrorToggle,
		summaryLabel = summaryLabel,
		validationLabel = validationLabel,
		warningLabel = warningLabel,
		diffFrame = diffFrame,
		approveButton = approveButton,
		rejectButton = rejectButton,
		_settings = { autoApply = false, scope = "", mirrorOutput = false },
		_pending = false,
	}, Widget)

	--[[
		People transcribe a code with the spacing and case they heard it in, and a
		lowercase or hyphenated code is not the code the daemon minted — it would
		spend one of five attempts to say so. Normalised as soon as the field is left,
		so what the box shows is what will be sent.
	]]
	codeBox.FocusLost:Connect(function()
		codeBox.Text = self:_normalisedCode()
	end)
	connectButton.Activated:Connect(function()
		options.onConnect(urlBox.Text, self:_normalisedCode())
	end)
	autoApplyToggle.Activated:Connect(function()
		self._settings.autoApply = not self._settings.autoApply
		self:_renderSettings()
		options.onSettingsChanged(table.clone(self._settings))
	end)
	mirrorToggle.Activated:Connect(function()
		self._settings.mirrorOutput = not self._settings.mirrorOutput
		self:_renderSettings()
		options.onSettingsChanged(table.clone(self._settings))
	end)
	scopeBox.FocusLost:Connect(function()
		self._settings.scope = scopeBox.Text
		options.onSettingsChanged(table.clone(self._settings))
	end)
	approveButton.Activated:Connect(function()
		if self._pending then
			self._pending = false
			self:_hideButtons()
			options.onApprove()
		end
	end)
	rejectButton.Activated:Connect(function()
		if self._pending then
			self._pending = false
			self:_hideButtons()
			options.onReject()
		end
	end)

	return self
end

function Widget:_normalisedCode(): string
	local typed = self.codeBox.Text
	if type(self.normalisePairingCode) == "function" then
		return self.normalisePairingCode(typed)
	end
	return typed
end

--[[
	Say whether this link already holds a session key, and stop offering a code as
	if it were still needed.

	The box is cleared once pairing succeeds: a redeemed code is spent — single
	use, on the daemon's side — and leaving it on screen reads as something that
	could be used again.
]]
function Widget:setPaired(paired: boolean, sessionKeyId: string?)
	if paired then
		self.codeBox.Text = ""
		self.codeBox.PlaceholderText = if sessionKeyId
			then string.format("paired · %s", sessionKeyId)
			else "paired"
	else
		self.codeBox.PlaceholderText = "pairing code"
	end
end

function Widget:_renderSettings()
	self.autoApplyToggle.Text = if self._settings.autoApply then "Auto-apply: on" else "Auto-apply: off"
	self.mirrorToggle.Text = if self._settings.mirrorOutput
		then "Mirror Studio console to the producer: on"
		else "Mirror Studio console to the producer: off"
	self.scopeBox.Text = self._settings.scope
end

function Widget:setSettings(settings: any)
	self._settings = {
		autoApply = settings.autoApply == true,
		scope = settings.scope or "",
		mirrorOutput = settings.mirrorOutput == true,
	}
	if settings.baseUrl then
		self.urlBox.Text = settings.baseUrl
	end
	self:_renderSettings()
end

function Widget:setLink(state: string, posture: string, detail: string?)
	self.stateLabel.Text = state
	self.postureLabel.Text = if detail then string.format("%s — %s", posture, detail) else posture
end

function Widget:_hideButtons()
	self.approveButton.Visible = false
	self.rejectButton.Visible = false
end

function Widget:_clearDiff()
	for _, child in self.diffFrame:GetChildren() do
		if child:IsA("TextLabel") then
			child:Destroy()
		end
	end
end

function Widget:_line(text: string, token: string, order: number)
	create("TextLabel", {
		Text = text,
		LayoutOrder = order,
		Font = Enum.Font.Code,
		TextSize = 13,
		TextColor3 = colour(self.theme, token),
		TextXAlignment = Enum.TextXAlignment.Left,
		TextWrapped = true,
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
	}).Parent = self.diffFrame
end

--- Show a rendered diff and, when the decision needs a human, the two buttons.
function Widget:present(rendered: any, decision: Decision, needsApproval: boolean)
	self:_clearDiff()

	local summary = rendered.summary
	self.summaryLabel.Text = string.format(
		"%s\n%d operations · %d create · %d set · %d script · %d move · %d delete",
		rendered.changeSetSummary or "(no summary)",
		summary.total,
		summary.counts.createInstance,
		summary.counts.setProperty,
		summary.counts.writeScript,
		summary.counts.moveInstance,
		summary.counts.deleteInstance
	)

	self.validationLabel.Text = Approve.describeValidation(decision.validation)
	self.validationLabel.Visible = true

	-- Every word of this comes from `Approve.describeNotes`, blockers included.
	-- Anything composed here instead would be text no test can reach.
	local notes = Approve.describeNotes(decision, summary.instancesDestroyed)
	self.warningLabel.Text = notes
	self.warningLabel.Visible = notes ~= ""

	local order = 0
	-- Destructive first: it is the part of the diff a tired reviewer must not miss.
	for _, pass in { true, false } do
		for _, entry in rendered.entries do
			if entry.destructive == pass then
				order += 1
				self:_line(
					string.format("%d. %s", entry.index, entry.headline),
					if entry.destructive then "ErrorText" else "MainText",
					order
				)
				for _, detail in entry.details do
					order += 1
					self:_line("      " .. detail, "SubText", order)
				end
				if entry.warning then
					order += 1
					self:_line("      ! " .. entry.warning, "WarningText", order)
				end
			end
		end
	end

	self._pending = needsApproval
	self.approveButton.Visible = needsApproval
	self.rejectButton.Visible = needsApproval
	if needsApproval then
		self.gui.Enabled = true
	end
end

--- Report the outcome of an apply, verbatim about how far it got.
function Widget:report(text: string, isError: boolean?)
	self.summaryLabel.Text = text
	self.warningLabel.Visible = isError == true
	if isError then
		self.warningLabel.Text = "! the apply did not complete — see the diff for which operation stopped it"
	end
	self:_hideButtons()
	self._pending = false
end

return Approve
