--!strict
--[[
	Diff — rendering a ChangeSet as a before/after summary a human can read.

	Approval is only meaningful if the thing being approved is legible, and the
	ADR-012 mitigation is explicit about it: "diffs are grouped and summarised so
	approval is a glance, not an audit". So this module leans on three things —
	a headline count, the destructive operations pulled to the top of the reader's
	attention, and a real line-level delta for scripts rather than "source changed".

	It reads the current place through `ctx`, and never writes.
]]

local Diff = {}

export type Context = {
	--- resolve(path) -> (instance?, error?)
	resolve: (string) -> (any?, string?),
	--- describe(taggedValue) -> string
	describe: (any) -> string,
	--- encode(liveValue) -> (ok, taggedValue)  (optional; enables before/after)
	encode: ((any, any?) -> (boolean, any))?,
	countDescendants: ((any) -> number)?,
}

--[[
	Split into lines. A single trailing newline is treated as a terminator rather
	than as an extra empty line, so "a\nb" and "a\nb\n" both count as two lines —
	otherwise every diff of a well-formed file reports a phantom last line.
]]
local function lines(source: string): { string }
	local out: { string } = {}
	local start = 1
	while true do
		local index = string.find(source, "\n", start, true)
		if not index then
			table.insert(out, string.sub(source, start))
			break
		end
		table.insert(out, string.sub(source, start, index - 1))
		start = index + 1
	end
	if #out > 1 and out[#out] == "" then
		table.remove(out)
	end
	return out
end

--[[
	A cheap line delta: trim the common head and tail, report what is left.

	Not a minimal edit script — an LCS on a 1 MiB script would block Studio's main
	thread, and the reviewer's question is "which region changed", not "what is the
	shortest possible explanation of the change".
]]
function Diff.lineDelta(before: string, after: string): any
	local a, b = lines(before), lines(after)
	local head = 0
	while head < #a and head < #b and a[head + 1] == b[head + 1] do
		head += 1
	end
	local tail = 0
	while tail < (#a - head) and tail < (#b - head) and a[#a - tail] == b[#b - tail] do
		tail += 1
	end
	return {
		removed = #a - head - tail,
		added = #b - head - tail,
		firstChangedLine = head + 1,
		unchanged = head + tail,
		beforeLines = #a,
		afterLines = #b,
	}
end

local function preview(source: string, maxLines: number): { string }
	local out = {}
	local all = lines(source)
	for index = 1, math.min(maxLines, #all) do
		table.insert(out, all[index])
	end
	if #all > maxLines then
		table.insert(out, string.format("… %d more lines", #all - maxLines))
	end
	return out
end

local function countDescendants(instance: any): number
	local ok, descendants = pcall(function()
		return instance:GetDescendants()
	end)
	if ok and type(descendants) == "table" then
		return #descendants
	end
	return 0
end

--- Counts by operation kind, plus the numbers the approval UI gates on.
function Diff.summarise(changeSet: any): any
	local counts = {
		createInstance = 0,
		setProperty = 0,
		writeScript = 0,
		moveInstance = 0,
		deleteInstance = 0,
	}
	for _, operation in changeSet.operations do
		local kind = operation.op
		if counts[kind] ~= nil then
			counts[kind] += 1
		end
	end
	return {
		total = #changeSet.operations,
		counts = counts,
		deletions = counts.deleteInstance,
		destructive = counts.deleteInstance + counts.moveInstance,
	}
end

--[[
	Render every operation into { index, kind, path, headline, details, destructive }.

	An operation whose target cannot be resolved is rendered with the resolution
	error in place of a before-value. That is information the reviewer wants
	*before* approving, not an error they discover during the apply.
]]
function Diff.render(changeSet: any, ctx: Context): any
	local entries = {}

	for index, operation in changeSet.operations do
		local entry: any = {
			index = index,
			kind = operation.op,
			path = operation.path,
			details = {},
			destructive = operation.op == "deleteInstance" or operation.op == "moveInstance",
		}

		if operation.op == "createInstance" then
			entry.headline = string.format("create %s at %s", operation.className, operation.path)
			local propertyCount = 0
			for name, value in operation.properties or {} do
				propertyCount += 1
				table.insert(entry.details, string.format("%s = %s", name, ctx.describe(value)))
			end
			if propertyCount == 0 then
				table.insert(entry.details, "no properties set")
			end
			local existing = ctx.resolve(operation.path)
			if existing ~= nil then
				entry.warning = "something already exists at this path; the apply will refuse this operation"
			end
		elseif operation.op == "setProperty" then
			entry.headline = string.format("set %s.%s", operation.path, operation.property)
			local target, err = ctx.resolve(operation.path)
			local beforeText = "?"
			if target == nil then
				beforeText = string.format("<%s>", err or "not found")
				entry.warning = err
			elseif ctx.encode then
				local ok, current = pcall(function()
					return (target :: any)[operation.property]
				end)
				if ok then
					local encodeOk, tagged = ctx.encode(current, nil)
					beforeText = if encodeOk then ctx.describe(tagged) else tostring(tagged)
				else
					beforeText = "<unreadable>"
					entry.warning = string.format("%s has no readable property %s", operation.path, operation.property)
				end
			end
			table.insert(entry.details, string.format("before: %s", beforeText))
			table.insert(entry.details, string.format("after:  %s", ctx.describe(operation.value)))
		elseif operation.op == "writeScript" then
			local target, err = ctx.resolve(operation.path)
			if target == nil then
				entry.headline = string.format("create %s %s", operation.scriptType, operation.path)
				table.insert(entry.details, string.format("%d lines, new file", #lines(operation.source)))
				for _, line in preview(operation.source, 12) do
					table.insert(entry.details, "+ " .. line)
				end
				if err and not string.find(err, "does not exist", 1, true) then
					entry.warning = err
				end
			else
				entry.headline = string.format("rewrite %s", operation.path)
				local ok, source = pcall(function()
					return (target :: any).Source
				end)
				if ok and type(source) == "string" then
					local delta = Diff.lineDelta(source, operation.source)
					table.insert(
						entry.details,
						string.format(
							"%d lines removed, %d added, first change at line %d",
							delta.removed,
							delta.added,
							delta.firstChangedLine
						)
					)
					entry.delta = delta
				else
					table.insert(entry.details, "current source could not be read")
					entry.warning = string.format("%s is a %s, not a script", operation.path, tostring(target.ClassName))
				end
				if target.ClassName ~= operation.scriptType then
					entry.warning = string.format(
						"%s is a %s but the operation declares a %s; the apply will refuse it",
						operation.path,
						tostring(target.ClassName),
						operation.scriptType
					)
				end
			end
		elseif operation.op == "moveInstance" then
			entry.headline = string.format("move %s → %s", operation.path, operation.to)
			local target, err = ctx.resolve(operation.path)
			if target == nil then
				entry.warning = err
			else
				local counter = ctx.countDescendants or countDescendants
				table.insert(entry.details, string.format("%d descendants move with it", counter(target)))
			end
		elseif operation.op == "deleteInstance" then
			entry.headline = string.format("DELETE %s", operation.path)
			local target, err = ctx.resolve(operation.path)
			if target == nil then
				entry.warning = err
			else
				local counter = ctx.countDescendants or countDescendants
				local total = counter(target) + 1
				table.insert(entry.details, string.format("%d instances destroyed", total))
				entry.instanceCount = total
			end
		else
			entry.headline = string.format("unknown operation %q", tostring(operation.op))
			entry.warning = "this plugin does not understand this operation and will refuse it"
		end

		table.insert(entries, entry)
	end

	local summary = Diff.summarise(changeSet)
	local destroyed = 0
	for _, entry in entries do
		destroyed += entry.instanceCount or 0
	end
	summary.instancesDestroyed = destroyed

	return { summary = summary, entries = entries, changeSetSummary = changeSet.summary }
end

--- Plain-text rendering, for the output log and for tests.
function Diff.toText(rendered: any): string
	local out = { rendered.changeSetSummary or "(no summary)" }
	local summary = rendered.summary
	table.insert(
		out,
		string.format(
			"%d operations — %d create, %d set, %d script, %d move, %d delete",
			summary.total,
			summary.counts.createInstance,
			summary.counts.setProperty,
			summary.counts.writeScript,
			summary.counts.moveInstance,
			summary.counts.deleteInstance
		)
	)
	if summary.instancesDestroyed > 0 then
		table.insert(out, string.format("%d instances would be destroyed", summary.instancesDestroyed))
	end
	for _, entry in rendered.entries do
		table.insert(out, string.format("%d. %s", entry.index, entry.headline))
		for _, detail in entry.details do
			table.insert(out, "     " .. detail)
		end
		if entry.warning then
			table.insert(out, "     ! " .. entry.warning)
		end
	end
	return table.concat(out, "\n")
end

return Diff
