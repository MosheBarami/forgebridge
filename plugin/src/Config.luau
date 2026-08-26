--!strict
--[[
	Config — protocol constants and the plugin's persisted settings.

	The constants below mirror `packages/protocol/src/{version,limits,link}.ts`.
	They are copied rather than imported because the plugin is Luau and shares no
	code with the TypeScript packages (REPO-LAYOUT boundary rule 4).

	TODO(M41): a conformance test must pin these against the committed JSON Schema
	so the two cannot drift silently. Two milestones deep — M08 generates and
	commits that JSON Schema (nothing to compare against exists today), M41
	writes the test. `docs/REPO-LAYOUT.md` rule 4 and `plugin/README.md` carry
	the same pair. Owner: plugin + protocol.
]]

local Config = {}

-- packages/protocol/src/version.ts
Config.PROTOCOL_VERSION = "1.0.0"
Config.PROTOCOL_MAJOR = 1
Config.PLUGIN_VERSION_HEADER = "X-ForgeBridge-Plugin"
Config.PROTOCOL_VERSION_HEADER = "X-ForgeBridge-Protocol"

-- Stamped by release engineering at tag time.
-- TODO(M49): have the release job rewrite this line so a shipped .rbxm always
-- reports the build it actually is. Owner: release engineering.
Config.PLUGIN_VERSION = "0.1.0"

-- packages/protocol/src/limits.ts
Config.LIMITS = table.freeze({
	MAX_OPERATIONS = 500,
	MAX_SCRIPT_BYTES = 1048576,
	MAX_CHANGESET_BYTES = 8388608,
	MAX_PATH_DEPTH = 32,
	MAX_SEGMENT_LENGTH = 100,
	BULK_DELETE_CONFIRM_THRESHOLD = 10,
})

--[[
	packages/protocol/src/link.ts — PRIVACY_POSTURE, verbatim.

	Rendered as-is in the widget header. A padlock icon alone would be a lie in
	the relay-tls case, which is the whole reason these are sentences and not
	icons (ADR-014).
]]
Config.PRIVACY_POSTURE = table.freeze({
	["local-daemon"] = "Local — nothing leaves this machine",
	["relay-tls"] = "Relay — the relay operator can read your changes",
	["relay-e2e"] = "Relay — end-to-end encrypted, the relay sees only ciphertext",
})

--[[
	`OutputLevel` from `packages/daemon/src/wire.ts`, keyed by the `Enum.MessageType`
	name Studio reports.

	The daemon validates the level against its own four names and refuses the batch
	on anything else, which would present to the user as the console mirror quietly
	switching itself off. Studio's names are not those names, so the translation has
	to happen somewhere; it happens here, next to every other constant this plugin
	mirrors, rather than inline at the call site.
]]
Config.OUTPUT_LEVEL = table.freeze({
	MessageOutput = "print",
	MessageInfo = "info",
	MessageWarning = "warning",
	MessageError = "error",
})

-- The daemon caps a single mirrored line at 10_000 characters and a batch at 200.
Config.OUTPUT = table.freeze({
	MAX_MESSAGE_CHARS = 10000,
	MAX_BATCH = 200,
})

--[[
	The link headers, from `packages/daemon/src/server.ts`.

	They live there rather than in `packages/protocol`, which is why they are
	mirrored from the daemon and not from the protocol package like everything else
	above. The M41 conformance test owes them the same pinning.
]]
Config.LINK_HEADER = "X-ForgeBridge-Link"
Config.MAC_HEADER = "X-ForgeBridge-Mac"

--[[
	Keys for plugin:GetSetting / plugin:SetSetting. Namespaced because Studio
	shares one settings store per plugin, not per script.

	The six link keys are one record split across five keys: without all of them a
	Studio restart cannot resume, and the user is asked for a pairing code they no
	longer have (codes live ten minutes and are single-use). `SESSION_KEY` holds
	the pairing-derived key itself, base64-encoded because Studio's settings store
	round-trips through JSON and raw key bytes would not survive it.

	The key is a secret at rest in Studio's settings, which is the same place the
	base URL lives and is readable by anything that can read the user's Studio
	profile. That is the cost of not asking for a fresh code every restart; the
	daemon holds its half in memory only, so a daemon restart invalidates this copy
	and the user re-pairs anyway.
]]
Config.SETTING = table.freeze({
	BASE_URL = "forgebridge.baseUrl",
	LINK_ID = "forgebridge.linkId",
	SESSION_KEY = "forgebridge.sessionKey",
	SESSION_KEY_ID = "forgebridge.sessionKeyId",
	PROJECT_ID = "forgebridge.projectId",
	--- The last delivery nonce accepted: where a resumed poll starts from.
	LINK_CURSOR = "forgebridge.linkCursor",
	--- The last envelope nonce sent. Monotonic per link, never reused.
	LINK_NONCE = "forgebridge.linkNonce",
	AUTO_APPLY = "forgebridge.autoApply",
	AUTO_APPLY_SCOPE = "forgebridge.autoApplyScope",
	MIRROR_OUTPUT = "forgebridge.mirrorOutput",
})

--[[
	The local daemon's fixed address — `DEFAULT_DAEMON_PORT` in
	`packages/daemon/src/server.ts`, which is where the number is decided.

	It is a default and not a constant: the widget still lets the URL be edited and
	remembers what was entered. But it has to have one, because Roblox grants a
	plugin permission per *address* — a user who types the address themselves gets
	the same prompt either way, and a wrong guess produces a plugin that silently
	fails to connect. The M41 conformance test above is what stops this drifting
	from the daemon's constant.
]]
Config.DEFAULT_BASE_URL = "http://127.0.0.1:7317" :: string?

Config.DEFAULTS = table.freeze({
	AUTO_APPLY = false, -- ADR-012: approval-required is the default posture.
	AUTO_APPLY_SCOPE = "",
	-- Off by default: the console can carry anything the place prints, and on a
	-- relay-tls link that is readable by the relay operator.
	MIRROR_OUTPUT = false,
})

return Config
