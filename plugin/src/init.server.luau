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

	The loop is: pair → poll → diff → approve → apply → report → journal, and a
	rollback the user asks for arrives back down the same poll. The plugin calls
	exactly six endpoints, and nothing else (PROTOCOL.md).
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")

local Approve = require(script.Approve)
local Apply = require(script.Apply)
local Config = require(script.Config)
local Crypto = require(script.Crypto)
local Diff = require(script.Diff)
local Journal = require(script.Journal)
local Pairing = require(script.Pairing)
local Path = require(script.Path)
local Rollback = require(script.Rollback)
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

local function readNumberSetting(key: string, fallback: number): number
	local value = readSetting(key, fallback)
	return if type(value) == "number" then value else fallback
end

--[[
	The session key comes back from settings base64-encoded (Config.SETTING).
	Decoding is pcall'd because a truncated or hand-edited setting must present as
	"not paired", asking for a code — not as an error thrown while the plugin is
	still loading, which would leave Studio with no widget at all.
]]
local function readSessionKey(): string?
	local encoded = readSetting(Config.SETTING.SESSION_KEY, nil)
	if type(encoded) ~= "string" or encoded == "" then
		return nil
	end
	local ok, raw = pcall(Crypto.fromBase64, encoded)
	if not ok or type(raw) ~= "string" or raw == "" then
		return nil
	end
	return raw
end

local state = {
	baseUrl = readSetting(Config.SETTING.BASE_URL, Config.DEFAULT_BASE_URL),
	linkId = readSetting(Config.SETTING.LINK_ID, nil),
	sessionKey = readSessionKey(),
	sessionKeyId = readSetting(Config.SETTING.SESSION_KEY_ID, nil),
	projectId = readSetting(Config.SETTING.PROJECT_ID, nil),
	cursor = readNumberSetting(Config.SETTING.LINK_CURSOR, 0),
	outboundNonce = readNumberSetting(Config.SETTING.LINK_NONCE, 0),
	autoApply = readSetting(Config.SETTING.AUTO_APPLY, Config.DEFAULTS.AUTO_APPLY) == true,
	scope = readSetting(Config.SETTING.AUTO_APPLY_SCOPE, Config.DEFAULTS.AUTO_APPLY_SCOPE),
	mirrorOutput = readSetting(Config.SETTING.MIRROR_OUTPUT, Config.DEFAULTS.MIRROR_OUTPUT) == true,
}

--- A link is only usable when both halves survived: the id names it, the key proves it.
local function isPaired(): boolean
	return type(state.linkId) == "string" and state.linkId ~= "" and type(state.sessionKey) == "string"
end

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

--[[
	The rollback executor, built on the applier rather than beside it.

	The applier owns the tree version, and two owners of that number is the defect
	this avoids: a reversal that moved its own copy would leave the next
	ChangeSet's `baseVersion` check comparing against a version the applier had
	never heard of.
]]
local reverser = Rollback.new({
	applier = applier,
	decodeJson = function(text: string)
		return HttpService:JSONDecode(text)
	end,
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

--[[
	Both are optional on `PairRequest` and both are for the daemon's link record —
	so a user with two Studio windows open can tell which link is which. Read
	through pcall for the same reason the theme is: a plugin that fails to load
	because one identifying string was unavailable helps nobody.
]]
local studioVersion: string? = nil
local placeId: number? = nil
do
	local ok, value = pcall(function()
		return version()
	end)
	studioVersion = if ok and type(value) == "string" then value else nil

	local placeOk, place = pcall(function()
		return game.PlaceId
	end)
	placeId = if placeOk and type(place) == "number" then place else nil
end

local transport: any = nil
local queue: { any } = {}
local pending: any = nil
local widget: any
local connect: () -> ()
local pairAndConnect: (string?) -> ()
-- Forward-declared here with the other mutually-recursive parts rather than
-- beside `applyChangeSet`: `rollback` also has to hand the queue back on when a
-- reversal finishes, and it is defined above that point.
local presentNext: () -> ()

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

--[[
	Hand the inverses to the daemon, so a rollback can outlive this Studio session.

	Posted right after the ApplyResult and never before it: the daemon attaches
	the entry to the apply it already witnessed, and refuses one for an apply it
	has not seen.

	A failure here is reported plainly rather than swallowed, because of what it
	costs. The change is already in the place; what is missing is the durable route
	back from it. The session journal still holds the inverses, so an in-session
	undo still works — and that is exactly the distinction the message draws, since
	a user who closes Studio believing a rollback is available would find out only
	when they needed it.
]]
local function uploadJournal(entry: any)
	if not transport then
		return
	end
	local wire, reason = Journal.wireEntry(entry, state.projectId)
	if not wire then
		-- Not every refusal is a fault: an apply that changed nothing has no
		-- inverses, and there is nothing to say about that.
		if entry.applied and #entry.applied > 0 then
			log(string.format("the inverses for this apply could not be prepared: %s", tostring(reason)))
		end
		return
	end
	local ok, err = transport:postJournalEntry(wire)
	if not ok then
		log(
			string.format(
				"applied, but the inverse operations could not be uploaded: %s — this apply can still be undone in this Studio session, and not after it closes",
				tostring(err)
			)
		)
	end
end

--[[
	Replay a rollback the user asked for, and report how far it got.

	Runs on the poll thread like an apply does, so the link is quiet while the tree
	is being changed and the next delivery is built against a version this plugin
	has already reported.
]]
local function rollback(delivery: any)
	local result, notes = reverser:execute(delivery)
	local summary = Rollback.summarise(result)
	local fully = Rollback.isFullyReversed(result)

	log(string.format("rollback of %s — %s", tostring(delivery.changeSetId), summary))
	for _, note in notes do
		log(note)
	end
	if not fully then
		for _, outcome in result.outcomes do
			if not outcome.ok then
				log(string.format("  inverse %d: %s", outcome.index, tostring(outcome.error)))
			end
		end
	end

	widget:report(string.format("Rollback\n%s", summary), not fully)

	if transport then
		local ok, reason = transport:postRollbackResult(result)
		if not ok then
			-- The reversal already happened. Saying so plainly matters more here
			-- than anywhere else: without this report the producer's journal stays
			-- at "requested" forever, and a user reading that would try again
			-- against inverses that are already spent.
			log(string.format("the rollback result could not be reported: %s", tostring(reason)))
		end
	end
	presentNext()
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
	uploadJournal(entry)
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
	onConnect = function(url, pairingCode)
		state.baseUrl = url
		writeSetting(Config.SETTING.BASE_URL, url)
		pairAndConnect(pairingCode)
	end,
	normalisePairingCode = Crypto.normalisePairingCode,
})

widget:setSettings({
	autoApply = state.autoApply,
	scope = state.scope,
	mirrorOutput = state.mirrorOutput,
	baseUrl = state.baseUrl,
})
widget:setPaired(isPaired(), state.sessionKeyId)

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

--[[
	Said before Roblox says anything, and before the first request rather than
	after it.

	A plugin may call HttpService without the place's "Allow HTTP Requests"
	setting, but the first call to a web address raises a Roblox permission prompt
	scoped to that address, which the user can deny. A prompt nobody explained gets
	denied, and a denied prompt looks exactly like a broken plugin — so the address
	is named in the panel and in the Output window first. Pairing is now what makes
	that first call, which is why this is announced here and not only in `connect`.
]]
local function announceAddress(): string
	local invitation = string.format(
		"Studio may ask permission to reach %s — allow it or this link cannot connect",
		tostring(state.baseUrl)
	)
	log(invitation)
	return invitation
end

local function postureText(): string
	local parts = Transport.parseBaseUrl(state.baseUrl)
	if not parts then
		return "No daemon configured"
	end
	local kind = Transport.transportKind(parts)
	return Config.PRIVACY_POSTURE[kind] or kind
end

--- Persist a link so the next Studio session does not need a code that no longer exists.
local function storeLink(link: any)
	state.linkId = link.linkId
	state.sessionKey = link.sessionKey
	state.sessionKeyId = link.sessionKeyId
	state.projectId = link.projectId
	state.cursor = link.since
	-- A fresh pairing is a fresh key, and the daemon's watermark for it starts at
	-- the origin. Carrying the old counter over would only skip nonces; resetting
	-- keeps the two ends' idea of "first envelope" the same.
	state.outboundNonce = 0

	writeSetting(Config.SETTING.LINK_ID, state.linkId)
	writeSetting(Config.SETTING.SESSION_KEY, Crypto.toBase64(link.sessionKey))
	writeSetting(Config.SETTING.SESSION_KEY_ID, state.sessionKeyId)
	writeSetting(Config.SETTING.PROJECT_ID, state.projectId)
	writeSetting(Config.SETTING.LINK_CURSOR, state.cursor)
	writeSetting(Config.SETTING.LINK_NONCE, state.outboundNonce)
end

--[[
	Redeem a code if one was typed, then connect.

	An empty box is not an error: after a restart the link is already in settings
	and Connect means "resume". It is only an error when there is nothing stored to
	resume, and then the widget says which of the two things is missing rather than
	starting a poll loop that can only ever be refused.
]]
pairAndConnect = function(pairingCode: string?)
	local code = Crypto.normalisePairingCode(pairingCode or "")
	if code == "" then
		if not isPaired() then
			local reason = "no pairing code, and no link stored — run the daemon and type the code it prints"
			log(reason)
			widget:setLink(STATE_TEXT.unpaired, postureText(), reason)
			return
		end
		connect()
		return
	end

	if transport then
		transport:stop()
		transport = nil
	end

	widget:setLink(STATE_TEXT.connecting, postureText(), announceAddress())

	local link, reason = Pairing.pair(state.baseUrl, code, {
		http = HttpService,
		encodeJson = function(payload)
			return HttpService:JSONEncode(payload)
		end,
		decodeJson = function(text)
			return HttpService:JSONDecode(text)
		end,
		crypto = Crypto,
		vetUrl = Transport.parseBaseUrl,
		pluginVersion = Config.PLUGIN_VERSION,
		protocolVersion = Config.PROTOCOL_VERSION,
		protocolMajor = Config.PROTOCOL_MAJOR,
		pluginVersionHeader = Config.PLUGIN_VERSION_HEADER,
		protocolVersionHeader = Config.PROTOCOL_VERSION_HEADER,
		--[[
			No `projectId`. `PairRequest` allows one and the daemon falls back to its
			own default without it — and the default is the right answer here, because
			the only project id this plugin has ever seen is one an earlier pairing
			handed it. Sending that back would bind the new link to a project the
			daemon may no longer route to, and `findPairedLink` would then look for a
			Studio session under the default project and find none: deliveries would
			stop with both ends believing they were paired.
		]]
		studioVersion = studioVersion,
		placeId = placeId,
	})
	if not link then
		-- Every pairing failure has a different next action, so the daemon's own
		-- words go through to the panel unedited.
		log(string.format("pairing failed: %s", tostring(reason)))
		widget:setLink(STATE_TEXT.unpaired, postureText(), reason)
		widget:setPaired(false)
		return
	end

	storeLink(link)
	widget:setPaired(true, link.sessionKeyId)
	log(Pairing.describe(link))
	connect()
end

connect = function()
	if transport then
		transport:stop()
		transport = nil
	end
	if not state.baseUrl or state.baseUrl == "" then
		widget:setLink("Not connected", "No daemon configured", nil)
		return
	end
	if not isPaired() then
		local reason = "this link has no session key — enter the daemon's pairing code and connect"
		widget:setLink(STATE_TEXT.unpaired, postureText(), reason)
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
		sessionKey = state.sessionKey,
		crypto = Crypto,
		cursor = state.cursor,
		outboundNonce = state.outboundNonce,
	})
	if not created then
		widget:setLink("Not connected", "That base URL was refused", err)
		log(tostring(err))
		return
	end

	transport = created
	--[[
		Both counters are link bookkeeping the transport moves and this file owns:
		written through on every change so a Studio restart resumes at the delivery
		it stopped at, and sends its next envelope above the watermark the daemon is
		already holding. A missed write costs a replayed delivery or a refused
		envelope, so neither is batched.
	]]
	transport.onCursor = function(cursor)
		state.cursor = cursor
		writeSetting(Config.SETTING.LINK_CURSOR, cursor)
	end
	transport.onNonce = function(nonce)
		state.outboundNonce = nonce
		writeSetting(Config.SETTING.LINK_NONCE, nonce)
	end
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
	transport.onRollback = rollback
	transport.onChangeSet = function(changeSet)
		if #queue >= 10 then
			log("dropping a delivery: ten ChangeSets are already waiting for review")
			report(refusalResult(changeSet, "the plugin's review queue is full"))
			return
		end
		table.insert(queue, changeSet)
		presentNext()
	end

	widget:setLink(
		STATE_TEXT.connecting,
		Config.PRIVACY_POSTURE[transport.kind] or transport.kind,
		announceAddress()
	)
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
