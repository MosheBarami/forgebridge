import type { TreeInstanceRecord } from './model';

/**
 * An example place, and the rules it is held to.
 *
 * This exists because of an awkward fact: nothing writes a tree snapshot yet
 * (M34) and nothing stores a ChangeSet locally yet (M35), so for every reader
 * today this surface has no data. A surface that can only ever be seen empty is
 * a surface nobody can review, and one whose graph, keyboard model and RTL
 * mirroring have never been looked at is one where all three are broken.
 *
 * So there is an example. Three rules keep it from being a lie:
 *
 *  1. **It is never the default.** It appears only after the reader presses a
 *     control that says what it will do.
 *  2. **It is labelled the entire time it is shown**, in a banner above the
 *     graph, not in a footnote — and the banner carries the control that clears
 *     it.
 *  3. **It is never written to storage.** It lives in component state for as
 *     long as the page does. A reader who reloads gets their own data, or the
 *     honest empty state, and never this.
 *
 * What it is: the place you would have if you used five of the starter cards
 * from the inventory (M36) — shop, leaderstats, checkpoints, sprint, currency
 * pickup — and applied them. The Luau below is short but real, and the edges the
 * map draws from it are produced by running the same extractor over it that runs
 * over a user's own scripts. Nothing here is a hand-drawn diagram.
 */

const SHOP_CATALOG = `local ShopCatalog = {}

ShopCatalog.items = {
\t{ id = "sword", name = "Sword", price = 50, tool = "Sword" },
\t{ id = "torch", name = "Torch", price = 15, tool = "Torch" },
}

function ShopCatalog.find(id)
\tfor _, item in ipairs(ShopCatalog.items) do
\t\tif item.id == id then
\t\t\treturn item
\t\tend
\tend
\treturn nil
end

return ShopCatalog
`;

const SHOP_SERVICE = `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local ShopCatalog = require(ReplicatedStorage.ShopCatalog)
local Stats = require(script.Parent.LeaderstatsService.Stats)

local Remotes = ReplicatedStorage:WaitForChild("Remotes")

local lastPurchase = {}

Remotes.PurchaseItem.OnServerInvoke = function(player, itemId)
\tif typeof(itemId) ~= "string" then
\t\treturn false, "bad request"
\tend

\tlocal now = os.clock()
\tif lastPurchase[player.UserId] and now - lastPurchase[player.UserId] < 0.5 then
\t\treturn false, "too fast"
\tend
\tlastPurchase[player.UserId] = now

\tlocal item = ShopCatalog.find(itemId)
\tif not item then
\t\treturn false, "no such item"
\tend
\tif Stats.Get(player, "Coins") < item.price then
\t\treturn false, "not enough coins"
\tend

\tStats.Add(player, "Coins", -item.price)
\tServerStorage.ShopItems[item.tool]:Clone().Parent = player.Backpack
\treturn true
end
`;

const LEADERSTATS_SERVICE = `local Players = game:GetService("Players")

local Stats = require(script.Stats)

Players.PlayerAdded:Connect(function(player)
\tlocal folder = Instance.new("Folder")
\tfolder.Name = "leaderstats"

\tfor _, name in ipairs({ "Coins", "Wins" }) do
\t\tlocal value = Instance.new("IntValue")
\t\tvalue.Name = name
\t\tvalue.Value = 0
\t\tvalue.Parent = folder
\tend

\tfolder.Parent = player
\tStats.ensure(player)
end)
`;

const LEADERSTATS_STATS = `local Stats = {}

function Stats.ensure(player)
\treturn player:WaitForChild("leaderstats")
end

function Stats.Get(player, name)
\tlocal folder = player:FindFirstChild("leaderstats")
\tlocal value = folder and folder:FindFirstChild(name)
\treturn value and value.Value or 0
end

function Stats.Add(player, name, delta)
\tassert(delta == math.floor(delta), "delta must be an integer")
\tlocal folder = player:WaitForChild("leaderstats")
\tlocal value = folder:WaitForChild(name)
\tvalue.Value = math.max(0, value.Value + delta)
\treturn value.Value
end

return Stats
`;

const CHECKPOINT_SERVICE = `local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")

local Stats = require(script.Parent.LeaderstatsService.Stats)

local checkpoints = Workspace:WaitForChild("Checkpoints")

local function stageOf(player)
\treturn Stats.Get(player, "Stage")
end

Players.PlayerAdded:Connect(function(player)
\tplayer.RespawnLocation = checkpoints:FindFirstChild(tostring(math.max(1, stageOf(player))))
end)

for _, pad in ipairs(checkpoints:GetChildren()) do
\tlocal index = tonumber(pad.Name)
\tif index then
\t\tpad.Touched:Connect(function(hit)
\t\t\tlocal character = hit.Parent
\t\t\tlocal humanoid = character and character:FindFirstChildOfClass("Humanoid")
\t\t\tif not humanoid or humanoid.Health <= 0 then
\t\t\t\treturn
\t\t\tend
\t\t\tlocal player = Players:GetPlayerFromCharacter(character)
\t\t\tif player and index > stageOf(player) then
\t\t\t\tStats.Set(player, "Stage", index)
\t\t\t\tplayer.RespawnLocation = pad
\t\t\tend
\t\tend)
\tend
end
`;

const COIN_SERVICE = `local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")

local Stats = require(script.Parent.LeaderstatsService.Stats)

local coins = Workspace:WaitForChild("Coins")
local taken = {}

for _, coin in ipairs(coins:GetChildren()) do
\tcoin.Touched:Connect(function(hit)
\t\tif taken[coin] then
\t\t\treturn
\t\tend
\t\tlocal player = Players:GetPlayerFromCharacter(hit.Parent)
\t\tif not player then
\t\t\treturn
\t\tend

\t\ttaken[coin] = true
\t\tlocal amount = coin:FindFirstChild("Value")
\t\tStats.Add(player, "Coins", amount and amount.Value or 1)

\t\tcoin.Transparency = 1
\t\tcoin.CanTouch = false
\t\ttask.wait(8)
\t\tcoin.Transparency = 0
\t\tcoin.CanTouch = true
\t\ttaken[coin] = nil
\tend)
end
`;

const SPRINT_CONTROLLER = `local ContextActionService = game:GetService("ContextActionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Remotes = ReplicatedStorage:WaitForChild("Remotes")

local function onSprint(_, state)
\tRemotes.SetSprinting:FireServer(state == Enum.UserInputState.Begin)
end

ContextActionService:BindAction("Sprint", onSprint, false, Enum.KeyCode.LeftShift)
`;

const SPRINT_SERVICE = `local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Remotes = ReplicatedStorage:WaitForChild("Remotes")

local BASE_SPEED = 16
local SPRINT_SPEED = 24
local stamina = {}
local lastCall = {}

Remotes.SetSprinting.OnServerEvent:Connect(function(player, wants)
\tlocal now = os.clock()
\tif lastCall[player] and now - lastCall[player] < 0.25 then
\t\treturn
\tend
\tlastCall[player] = now

\tlocal character = player.Character
\tlocal humanoid = character and character:FindFirstChildOfClass("Humanoid")
\tif not humanoid then
\t\treturn
\tend

\tstamina[player] = stamina[player] or 100
\thumanoid.WalkSpeed = (wants == true and stamina[player] > 0) and SPRINT_SPEED or BASE_SPEED
end)
`;

const SHOP_GUI_CONTROLLER = `local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local buyButton = script.Parent:WaitForChild("Buy")

buyButton.Activated:Connect(function()
\tlocal ok, reason = Remotes.PurchaseItem:InvokeServer("sword")
\tif not ok then
\t\tscript.Parent.Status.Text = reason
\tend
end)
`;

/**
 * The instances. `className` and `source` are exactly what a captured snapshot
 * would carry, which is the second reason this file earns its place: it is a
 * worked example of the shape `ProjectTreeSnapshot` expects, sitting next to the
 * schema that defines it.
 */
export const EXAMPLE_INSTANCES: readonly TreeInstanceRecord[] = [
  { path: 'ReplicatedStorage.ShopCatalog', className: 'ModuleScript', source: SHOP_CATALOG },
  { path: 'ReplicatedStorage.Remotes', className: 'Folder' },
  { path: 'ReplicatedStorage.Remotes.PurchaseItem', className: 'RemoteFunction' },
  { path: 'ReplicatedStorage.Remotes.SetSprinting', className: 'RemoteEvent' },

  {
    path: 'ServerScriptService.ShopService',
    className: 'Script',
    source: SHOP_SERVICE,
  },
  {
    path: 'ServerScriptService.LeaderstatsService',
    className: 'Script',
    source: LEADERSTATS_SERVICE,
  },
  {
    path: 'ServerScriptService.LeaderstatsService.Stats',
    className: 'ModuleScript',
    source: LEADERSTATS_STATS,
  },
  {
    path: 'ServerScriptService.CheckpointService',
    className: 'Script',
    source: CHECKPOINT_SERVICE,
  },
  { path: 'ServerScriptService.CoinService', className: 'Script', source: COIN_SERVICE },
  { path: 'ServerScriptService.SprintService', className: 'Script', source: SPRINT_SERVICE },

  {
    path: 'StarterPlayer.StarterPlayerScripts.SprintController',
    className: 'LocalScript',
    source: SPRINT_CONTROLLER,
  },
  {
    path: 'StarterGui.ShopGui.Controller',
    className: 'LocalScript',
    source: SHOP_GUI_CONTROLLER,
  },

  { path: 'Workspace.Checkpoints', className: 'Folder' },
  { path: 'Workspace.Coins', className: 'Folder' },
  { path: 'ServerStorage.ShopItems', className: 'Folder' },
];
