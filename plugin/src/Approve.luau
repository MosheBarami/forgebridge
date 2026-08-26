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
	    than a padlock, the summary, whose verdict it is showing, the destructive
	    operations first, and then the diff. Approval is meant to be a glance, not
	    an audit.

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
	for _, operation in changeSet.operations or {} do
		if operation.op == "deleteInstance" then
			deletions += 1
		elseif operation.op == "moveInstance" then
			moves += 1
		end
		if carriesSource(operation) then
			sourceWrites += 1
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
	onConnect: (string) -> (),
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
		Size = UDim2.new(1, -76, 0, 26),
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
	}, { urlBox, connectButton })
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

	connectButton.Activated:Connect(function()
		options.onConnect(urlBox.Text)
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

	local notes = {}
	for _, warning in decision.warnings do
		table.insert(notes, "! " .. warning)
	end
	if summary.instancesDestroyed and summary.instancesDestroyed > 0 then
		table.insert(notes, string.format("! %d instances would be destroyed", summary.instancesDestroyed))
	end
	self.warningLabel.Text = table.concat(notes, "\n")
	self.warningLabel.Visible = #notes > 0

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
