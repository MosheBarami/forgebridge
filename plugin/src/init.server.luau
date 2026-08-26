--!nonstrict
--[[
	ForgeBridge — Roblox Studio plugin.

	This file is the only one that wires anything together. Every module under
	`src/` is a leaf: none of them calls `require`, and none of them touches a
	Roblox service at module scope. That is not stylistic — Roblox's `require`
	takes an Instance, so a module that reaches for its neighbours cannot be loaded
	by any runtime except Studio, and the parts of this plugin most worth testing
	(path resolution, value decoding, inverse capture, the approval policy) would
	have no tests at all. Composition lives here so those stay testable.

	The loop is: poll → diff → approve → apply → report. The plugin calls exactly
	three endpoints, and nothing else (PROTOCOL.md).
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")

local Approve = require(script.Approve)
local Apply = require(script.Apply)
local Config = require(script.Config)
local Diff = require(script.Diff)
local Journal = require(script.Journal)
local Path = require(script.Path)
local Transport = require(script.Transport)
local Value = require(script.Value)

-- ── settings ──────────────────────────────────────────────────────────────────

local function readSetting(key: string, fallback: any): any
	local ok, value = pcall(function()
		return plugin:GetSetting(key)
	end)
	if ok and value ~= nil then
		return value
	end
	return fallback
end

local function writeSetting(key: string, value: any)
	pcall(function()
		plugin:SetSetting(key, value)
	end)
end

local state = {
	baseUrl = readSetting(Config.SETTING.BASE_URL, Config.DEFAULT_BASE_URL),
	linkId = readSetting(Config.SETTING.LINK_ID, nil),
	autoApply = readSetting(Config.SETTING.AUTO_APPLY, Config.DEFAULTS.AUTO_APPLY) == true,
	scope = readSetting(Config.SETTING.AUTO_APPLY_SCOPE, Config.DEFAULTS.AUTO_APPLY_SCOPE),
	mirrorOutput = readSetting(Config.SETTING.MIRROR_OUTPUT, Config.DEFAULTS.MIRROR_OUTPUT) == true,
}

-- ── composition ───────────────────────────────────────────────────────────────

local session = Journal.newSession(20)

local function encodeValue(value: any, options: any?): (boolean, any)
	local opts: any = options or {}
	opts.pathOf = opts.pathOf or Path.of
	return Value.encode(value, opts)
end

local applier = Apply.new({
	root = game,
	path = Path,
	value = Value,
	journal = Journal,
	instanceNew = function(className: string)
		return Instance.new(className)
	end,
	encodeJson = function(payload: any)
		return HttpService:JSONEncode(payload)
	end,
	newId = function()
		return HttpService:GenerateGUID(false)
	end,
	now = function()
		return DateTime.now():ToIsoDate()
	end,
	pluginVersion = Config.PLUGIN_VERSION,
	changeHistory = ChangeHistoryService,
	collectionService = CollectionService,
	maxScriptBytes = Config.LIMITS.MAX_SCRIPT_BYTES,
	maxOperations = Config.LIMITS.MAX_OPERATIONS,
})

local diffContext = {
	resolve = function(path: string)
		return Path.resolve(game, path)
	end,
	describe = Value.describe,
	encode = function(value: any)
		return encodeValue(value, nil)
	end,
}

-- ── widget ────────────────────────────────────────────────────────────────────

local toolbar = plugin:CreateToolbar("ForgeBridge")
-- TODO(M49): an icon asset id can only exist once the icon is uploaded by the
-- release job; an invented id would render as a broken image in every Studio.
-- Owner: release engineering.
local button = toolbar:CreateButton("ForgeBridge", "Review and apply ForgeBridge changes", "")
button.ClickableWhenViewportHidden = true

local widgetGui = plugin:CreateDockWidgetPluginGui(
	"ForgeBridge",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 400, 560, 320, 400)
)
widgetGui.Title = "ForgeBridge"
widgetGui.Name = "ForgeBridge"

local studioTheme: any = nil
do
	local ok, theme = pcall(function()
		return settings().Studio.Theme
	end)
	studioTheme = if ok then theme else nil
end

local transport: any = nil
local queue: { any } = {}
local pending: any = nil
local widget: any
local connect: () -> ()

local function log(message: string)
	print(string.format("[ForgeBridge] %s", message))
end

-- ── the loop ──────────────────────────────────────────────────────────────────

local function report(result: any)
	if not transport then
		return
	end
	local ok, reason = transport:postApplyResult(result)
	if not ok then
		-- The apply already happened. Failing to report it is a reporting problem,
		-- not a place problem, and saying exactly that beats a message that reads
		-- like the change was rolled back.
		log(string.format("applied, but the result could not be reported: %s", tostring(reason)))
	end
end

local function refusalResult(changeSet: any, reason: string): any
	local outcomes = {}
	for index = 1, #(changeSet.operations or {}) do
		table.insert(outcomes, { index = index - 1, ok = false, error = reason })
	end
	return {
		changeSetId = changeSet.id,
		outcomes = outcomes,
		newVersion = applier:version() or changeSet.baseVersion,
		journalId = HttpService:GenerateGUID(false),
		appliedAt = DateTime.now():ToIsoDate(),
		pluginVersion = Config.PLUGIN_VERSION,
	}
end

local presentNext: () -> ()

local function applyChangeSet(changeSet: any)
	local result, entry = applier:execute(changeSet)
	session:record(entry)

	local summary = Apply.summarise(result)
	local fully = Apply.isFullyApplied(result)
	log(string.format("%s — %s", changeSet.summary or changeSet.id, summary))
	for _, note in entry.notes or {} do
		log(note)
	end
	if not fully then
		for _, outcome in result.outcomes do
			if not outcome.ok then
				log(string.format("  operation %d: %s", outcome.index, tostring(outcome.error)))
			end
		end
	end

	widget:report(
		string.format("%s\n%s", changeSet.summary or "(no summary)", summary),
		not fully
	)
	report(result)
	presentNext()
end

function presentNext()
	if pending ~= nil or #queue == 0 then
		return
	end
	local changeSet = table.remove(queue, 1)
	local rendered = Diff.render(changeSet, diffContext)
	local decision = Approve.evaluate(changeSet, {
		autoApply = state.autoApply,
		scope = state.scope,
		bulkDeleteThreshold = Config.LIMITS.BULK_DELETE_CONFIRM_THRESHOLD,
	}, Path.isWithin)

	if decision.auto then
		widget:present(rendered, decision, false)
		applyChangeSet(changeSet)
		return
	end

	pending = { changeSet = changeSet, rendered = rendered }
	widget:present(rendered, decision, true)
	button:SetActive(true)
	log(string.format("waiting for approval: %s", changeSet.summary or changeSet.id))
end

widget = Approve.mount({
	gui = widgetGui,
	theme = studioTheme,
	onApprove = function()
		local current = pending
		pending = nil
		if current then
			applyChangeSet(current.changeSet)
		end
	end,
	onReject = function()
		local current = pending
		pending = nil
		if current then
			log(string.format("rejected: %s", current.changeSet.summary or current.changeSet.id))
			report(refusalResult(current.changeSet, "rejected in Studio"))
		end
		presentNext()
	end,
	onSettingsChanged = function(updated)
		state.autoApply = updated.autoApply
		state.scope = updated.scope
		state.mirrorOutput = updated.mirrorOutput
		writeSetting(Config.SETTING.AUTO_APPLY, state.autoApply)
		writeSetting(Config.SETTING.AUTO_APPLY_SCOPE, state.scope)
		writeSetting(Config.SETTING.MIRROR_OUTPUT, state.mirrorOutput)
	end,
	onConnect = function(url)
		state.baseUrl = url
		writeSetting(Config.SETTING.BASE_URL, url)
		connect()
	end,
})

widget:setSettings({
	autoApply = state.autoApply,
	scope = state.scope,
	mirrorOutput = state.mirrorOutput,
	baseUrl = state.baseUrl,
})

-- ── connection ────────────────────────────────────────────────────────────────

local STATE_TEXT = {
	connecting = "Connecting…",
	connected = "Connected",
	reconnecting = "Reconnecting…",
	unpaired = "Not paired",
	unauthenticated = "Not authenticated",
	throttled = "Throttled",
	blocked = "Blocked",
	["update-required"] = "Update required",
	error = "Error",
	idle = "Not connected",
}

connect = function()
	if transport then
		transport:stop()
		transport = nil
	end
	if not state.baseUrl or state.baseUrl == "" then
		widget:setLink("Not connected", "No daemon configured", nil)
		return
	end

	local created, err = Transport.new({
		baseUrl = state.baseUrl,
		http = HttpService,
		scheduler = { spawn = task.spawn, wait = task.wait },
		encodeJson = function(payload)
			return HttpService:JSONEncode(payload)
		end,
		decodeJson = function(text)
			return HttpService:JSONDecode(text)
		end,
		pluginVersion = Config.PLUGIN_VERSION,
		protocolVersion = Config.PROTOCOL_VERSION,
		protocolMajor = Config.PROTOCOL_MAJOR,
		pluginVersionHeader = Config.PLUGIN_VERSION_HEADER,
		protocolVersionHeader = Config.PROTOCOL_VERSION_HEADER,
		linkId = state.linkId,
	})
	if not created then
		widget:setLink("Not connected", "That base URL was refused", err)
		log(tostring(err))
		return
	end

	transport = created
	transport.onState = function(linkState, reason)
		widget:setLink(
			STATE_TEXT[linkState] or linkState,
			Config.PRIVACY_POSTURE[transport.kind] or transport.kind,
			reason
		)
		if linkState == "update-required" then
			-- Say it once, loudly, in the console as well as the widget: the loop
			-- is stopped and no further ChangeSet will be seen until the plugin is
			-- updated.
			log(string.format("stopped: %s", tostring(reason)))
		end
	end
	-- Applying runs on the poll thread, so the link is quiet while a ChangeSet is
	-- being applied and reported. That is the ordering we want: the next delivery
	-- is built against a version this plugin has already reported.
	transport.onChangeSet = function(changeSet)
		if #queue >= 10 then
			log("dropping a delivery: ten ChangeSets are already waiting for review")
			report(refusalResult(changeSet, "the plugin's review queue is full"))
			return
		end
		table.insert(queue, changeSet)
		presentNext()
	end

	--[[
		Said before Roblox says anything. A plugin may call HttpService without the
		place's "Allow HTTP Requests" setting, but the first call to a web address
		raises a Roblox permission prompt scoped to that address, which the user can
		deny. A prompt nobody explained gets denied, and a denied prompt looks
		exactly like a broken plugin — so the address is named here, in the panel and
		in the Output window, before the dialog can appear.
	]]
	local invitation = string.format("Studio may ask permission to reach %s — allow it or this link cannot connect", state.baseUrl)
	log(invitation)
	widget:setLink("Connecting…", Config.PRIVACY_POSTURE[transport.kind] or transport.kind, invitation)
	transport:start()
end

-- ── console mirror ────────────────────────────────────────────────────────────

--[[
	Off by default and never retroactive: the buffer only starts filling once the
	user turns it on. Studio's console carries whatever the place prints, and on a
	relay link the operator can read it.
]]
local outputBuffer: { any } = {}

local messageConnection = LogService.MessageOut:Connect(function(message: string, messageType: EnumItem)
	if not state.mirrorOutput then
		return
	end
	if #outputBuffer >= Config.OUTPUT.MAX_BATCH then
		table.remove(outputBuffer, 1)
	end
	-- Clipped here rather than at send time: a single over-long line would
	-- otherwise take a whole batch of legitimate output down with it, and the
	-- user would see the mirror stop with no line to blame.
	local text = if #message > Config.OUTPUT.MAX_MESSAGE_CHARS
		then string.sub(message, 1, Config.OUTPUT.MAX_MESSAGE_CHARS)
		else message
	table.insert(outputBuffer, {
		level = Config.OUTPUT_LEVEL[messageType.Name] or "print",
		message = text,
		at = DateTime.now():ToIsoDate(),
	})
end)

local mirrorRunning = true
task.spawn(function()
	while mirrorRunning do
		task.wait(2)
		if state.mirrorOutput and transport and #outputBuffer > 0 then
			local batch = outputBuffer
			outputBuffer = {}
			local ok, reason = transport:postOutput(batch)
			if not ok then
				log(string.format("console mirror paused: %s", tostring(reason)))
			end
		end
	end
end)

-- ── lifecycle ─────────────────────────────────────────────────────────────────

button.Click:Connect(function()
	widgetGui.Enabled = not widgetGui.Enabled
	button:SetActive(widgetGui.Enabled)
end)

widgetGui:GetPropertyChangedSignal("Enabled"):Connect(function()
	button:SetActive(widgetGui.Enabled)
end)

plugin.Unloading:Connect(function()
	mirrorRunning = false
	messageConnection:Disconnect()
	if transport then
		transport:stop()
	end
end)

connect()
