import type { OperationKind } from '@forgebridge/protocol';

/**
 * The starter set of mechanic cards.
 *
 * A mechanic card is a *recipe*, not a template and not a snippet: a named,
 * reusable expansion into (a) a prompt a model is asked to satisfy and (b) the
 * paths that prompt is allowed to touch. Using one does not write anything. It
 * starts a run, the run produces a ChangeSet in `validated`, and a human reads
 * the diff and approves it — ADR-012, the same gate as every other producer.
 *
 * Three rules held while writing these, because a catalog of lorem is worse
 * than no catalog:
 *
 *  1. **Every path is a real, addressable `InstancePath`.** Dotted, rooted at a
 *     service `@forgebridge/protocol` lists in `SERVICE_ROOTS`, every segment a
 *     safe identifier. `catalog.test.ts` parses all of them against the
 *     protocol's own schema, so a card that names a path the bridge could never
 *     address fails the build rather than failing a user's run.
 *
 *  2. **Every prompt says what the server must not trust.** These are Roblox
 *     mechanics, and the failure mode of a generated Roblox mechanic is a
 *     client that sends its own price, its own damage number or its own
 *     coordinates. A recipe that omits that is a recipe for an exploitable
 *     place, and the model will happily omit it if nobody asks.
 *
 *  3. **`plan` is what the recipe *intends*, not what a run *produced*.** It is
 *     labelled that way on screen. A model can and will deviate; the diff is
 *     the truth and the card never claims otherwise.
 *
 * The prompt text is English and is not translated. That is deliberate rather
 * than an omission: it is not interface copy, it is the literal payload handed
 * to a model, and a card whose displayed prompt differs from the one that gets
 * sent would be lying about the thing this whole product is built to make
 * legible. The card's *title*, *summary* and *caveat* — the parts a human reads
 * to choose — are in the dictionary and are translated.
 */

/**
 * Six categories, chosen because they are how a Roblox developer already sorts
 * this work, not because they balance the grid. `world` is the catch-all for
 * mechanics that live on parts in the place rather than in a system.
 */
export const CARD_CATEGORIES = [
  'economy',
  'progression',
  'movement',
  'interaction',
  'persistence',
  'world',
] as const;
export type CardCategory = (typeof CARD_CATEGORIES)[number];

/**
 * What a recipe is allowed to touch, and how.
 *
 * `intent` is not decoration. `creates` and `writes` are the operations a run
 * may propose inside this prefix; `reads` names a path the generated code will
 * reference but must not modify. A scope that only listed write targets would
 * hide the dependency edges — which is exactly what the game map (M37) needs in
 * order to draw anything.
 */
export interface PathScope {
  readonly path: string;
  readonly intent: 'creates' | 'writes' | 'reads';
}

/** One operation the recipe expects the run to produce. Intent, not outcome. */
export interface PlannedOperation {
  readonly op: OperationKind;
  readonly path: string;
  /** Class name, or script type. Rendered as mono, never translated. */
  readonly detail: string;
}

export interface MechanicCard {
  /** Stable slug. It is the URL segment and the dictionary key, so it is frozen. */
  readonly id: string;
  readonly category: CardCategory;
  /**
   * Where this card came from.
   *
   * TODO(M50): community submission. The shape a submitted card has to take is
   * this interface plus provenance — who submitted it, when, and against which
   * protocol version — and the review it has to pass is the one `catalog.test.ts`
   * already runs, promoted to a server-side check. Nothing in this file assumes
   * `starter` is the only value, and `inventory-browser.tsx` already groups by
   * this field, so the third state is a data change rather than a UI rewrite.
   */
  readonly source: 'starter' | 'community';
  /** The expansion. Sent to the model verbatim; shown to the user verbatim. */
  readonly prompt: string;
  readonly scope: readonly PathScope[];
  readonly plan: readonly PlannedOperation[];
  /**
   * Free-text search terms that are not in the translated title or summary —
   * the words a developer would actually type. Latin only, and matched in
   * addition to the translated strings rather than instead of them, so search
   * works in Hebrew without every card needing a Hebrew keyword list.
   */
  readonly keywords: readonly string[];
}

const CARDS_DATA: readonly MechanicCard[] = [
  {
    id: 'shop',
    category: 'economy',
    source: 'starter',
    keywords: ['shop', 'store', 'buy', 'purchase', 'gui', 'coins'],
    prompt: `Build a server-authoritative shop.

Create a ModuleScript at ReplicatedStorage.ShopCatalog that returns a table of
items. Each entry has: a string id, a display name, a price in the "Coins"
leaderstat, and the name of a Tool inside ServerStorage.ShopItems.

Create a RemoteFunction at ReplicatedStorage.Remotes.PurchaseItem.

Create a Script at ServerScriptService.ShopService that requires ShopCatalog and
sets OnServerInvoke. On each call it must: look up the item id and refuse an
unknown one; read the player's Coins leaderstat; refuse the purchase if Coins is
less than the price; deduct the price; clone the named Tool from
ServerStorage.ShopItems into the player's Backpack; and return a success boolean
plus a reason string when it refused.

The client sends an item id and nothing else. Never read a price, a name or a
quantity from the client. Reject a second call from the same player within 0.5
seconds and return a "too fast" reason rather than silently dropping it.`,
    scope: [
      { path: 'ReplicatedStorage.ShopCatalog', intent: 'creates' },
      // The folder is named as well as the remote inside it. A scope that only
      // listed the leaf would not cover the operation that makes the folder,
      // and a scope that does not cover the plan is a scope nobody can check.
      { path: 'ReplicatedStorage.Remotes', intent: 'creates' },
      { path: 'ServerScriptService.ShopService', intent: 'creates' },
      { path: 'ServerStorage.ShopItems', intent: 'reads' },
    ],
    plan: [
      { op: 'createInstance', path: 'ReplicatedStorage.Remotes', detail: 'Folder' },
      { op: 'createInstance', path: 'ReplicatedStorage.Remotes.PurchaseItem', detail: 'RemoteFunction' },
      { op: 'writeScript', path: 'ReplicatedStorage.ShopCatalog', detail: 'ModuleScript' },
      { op: 'writeScript', path: 'ServerScriptService.ShopService', detail: 'Script' },
    ],
  },
  {
    id: 'leaderstats',
    category: 'progression',
    source: 'starter',
    keywords: ['leaderstats', 'leaderboard', 'coins', 'stats', 'IntValue'],
    prompt: `Set up leaderstats.

Create a Script at ServerScriptService.LeaderstatsService. On Players.PlayerAdded
it creates a Folder named "leaderstats" inside the player, and inside it two
IntValues: "Coins" and "Wins", both starting at 0.

Create a ModuleScript at ServerScriptService.LeaderstatsService.Stats exposing
Get(player, name), Add(player, name, delta) and Set(player, name, value). Every
other server system changes a stat through this module and never by writing the
IntValue directly, so there is one place to add clamping and one place to hook
saving into later.

Add(player, name, delta) must clamp the result to zero or above and must refuse
a non-integer delta. Nothing here is exposed to a client: there is no
RemoteEvent in this card.`,
    scope: [
      { path: 'ServerScriptService.LeaderstatsService', intent: 'creates' },
      { path: 'ServerScriptService.LeaderstatsService.Stats', intent: 'creates' },
    ],
    plan: [
      { op: 'writeScript', path: 'ServerScriptService.LeaderstatsService', detail: 'Script' },
      { op: 'writeScript', path: 'ServerScriptService.LeaderstatsService.Stats', detail: 'ModuleScript' },
    ],
  },
  {
    id: 'checkpoints',
    category: 'progression',
    source: 'starter',
    keywords: ['checkpoint', 'obby', 'stage', 'spawn', 'respawn'],
    prompt: `Build an obby checkpoint system.

Assume a Folder at Workspace.Checkpoints containing SpawnLocation parts named
"1", "2", "3" and so on.

Create a Script at ServerScriptService.CheckpointService. On PlayerAdded it
creates an IntValue named "Stage" inside the player's leaderstats folder,
defaulting to 1, and it sets the player's RespawnLocation to the matching
SpawnLocation. It connects Touched on every checkpoint part; when a player's
character touches checkpoint N, and N is greater than that player's current
Stage, it sets Stage to N and updates RespawnLocation.

A touch must only count when the touching part belongs to a character with a
Humanoid whose Health is above zero, and the handler must ignore repeat touches
of a checkpoint the player has already reached — Touched fires many times per
second while a character rests on a part.

Never move a player forward on a client's say-so: there is no remote here.`,
    scope: [
      { path: 'ServerScriptService.CheckpointService', intent: 'creates' },
      { path: 'Workspace.Checkpoints', intent: 'reads' },
    ],
    plan: [
      { op: 'writeScript', path: 'ServerScriptService.CheckpointService', detail: 'Script' },
    ],
  },
  {
    id: 'daily-reward',
    category: 'economy',
    source: 'starter',
    keywords: ['daily', 'reward', 'streak', 'login', 'bonus'],
    prompt: `Build a daily login reward.

Create a Script at ServerScriptService.DailyRewardService. It uses a DataStore
named "DailyReward_v1" keyed by "player_" .. UserId, storing the os.time() of
the last claim and the current streak length.

On PlayerAdded, read the record. If more than 24 hours have passed since the last
claim, the player may claim; if more than 48 hours have passed, the streak resets
to 1 first. Grant Coins through ServerScriptService.LeaderstatsService.Stats,
scaling with the streak up to a cap of seven days.

Create a RemoteEvent at ReplicatedStorage.Remotes.DailyRewardClaimed and fire it
to that player with the amount granted and the new streak, so a UI can show it.

All timing is computed from os.time() on the server. Never accept a timestamp,
a streak count or an amount from a client. Wrap every DataStore call in pcall
and, if the read fails, do not grant anything and do not write a record — a
failed read that is treated as "no record" is how a player gets rewarded every
time the service has a bad minute.`,
    scope: [
      { path: 'ServerScriptService.DailyRewardService', intent: 'creates' },
      { path: 'ReplicatedStorage.Remotes.DailyRewardClaimed', intent: 'creates' },
      { path: 'ServerScriptService.LeaderstatsService.Stats', intent: 'reads' },
    ],
    plan: [
      { op: 'createInstance', path: 'ReplicatedStorage.Remotes.DailyRewardClaimed', detail: 'RemoteEvent' },
      { op: 'writeScript', path: 'ServerScriptService.DailyRewardService', detail: 'Script' },
    ],
  },
  {
    id: 'sprint-toggle',
    category: 'movement',
    source: 'starter',
    keywords: ['sprint', 'run', 'shift', 'stamina', 'walkspeed'],
    prompt: `Add a sprint toggle with stamina.

Create a LocalScript at StarterPlayer.StarterPlayerScripts.SprintController. It
binds LeftShift through ContextActionService, and while sprinting it fires
ReplicatedStorage.Remotes.SetSprinting with true, and with false on release or
when stamina runs out. It draws nothing; it only reports intent.

Create a RemoteEvent at ReplicatedStorage.Remotes.SetSprinting.

Create a Script at ServerScriptService.SprintService that owns the stamina and
the WalkSpeed. It holds per-player stamina, drains it while sprinting, refills it
while not, and sets Humanoid.WalkSpeed to the sprint value only while stamina
remains. It stops sprinting on its own when stamina hits zero, without waiting
for the client to say so.

WalkSpeed is set on the server. A client that sets its own WalkSpeed is a client
that has already exploited this. Debounce the remote: ignore more than four
calls per second from one player.`,
    scope: [
      { path: 'StarterPlayer.StarterPlayerScripts.SprintController', intent: 'creates' },
      { path: 'ReplicatedStorage.Remotes.SetSprinting', intent: 'creates' },
      { path: 'ServerScriptService.SprintService', intent: 'creates' },
    ],
    plan: [
      { op: 'createInstance', path: 'ReplicatedStorage.Remotes.SetSprinting', detail: 'RemoteEvent' },
      { op: 'writeScript', path: 'StarterPlayer.StarterPlayerScripts.SprintController', detail: 'LocalScript' },
      { op: 'writeScript', path: 'ServerScriptService.SprintService', detail: 'Script' },
    ],
  },
  {
    id: 'proximity-interaction',
    category: 'interaction',
    source: 'starter',
    keywords: ['proximityprompt', 'interact', 'press E', 'door', 'lever'],
    prompt: `Add a ProximityPrompt interaction.

Assume an interactable part at Workspace.Interactables.Lever.

Create the ProximityPrompt at Workspace.Interactables.Lever.Prompt with an
ActionText of "Use", an ObjectText of "Lever", a HoldDuration of 0.5 and a
MaxActivationDistance of 8.

Create a ModuleScript at ServerScriptService.InteractionService.Handlers holding
one function per prompt name, and a Script at ServerScriptService.InteractionService
that connects Triggered on every ProximityPrompt under Workspace.Interactables and
dispatches to the matching handler.

Re-check the distance between the player's character and the prompt's parent on
the server inside the Triggered handler. Triggered arrives from the client and a
client can fire it from anywhere on the map; MaxActivationDistance is a client-side
hint, not a check. Ignore a trigger from a player whose Humanoid is dead, and
debounce per player per prompt.`,
    scope: [
      { path: 'Workspace.Interactables.Lever.Prompt', intent: 'creates' },
      { path: 'ServerScriptService.InteractionService', intent: 'creates' },
      { path: 'ServerScriptService.InteractionService.Handlers', intent: 'creates' },
      { path: 'Workspace.Interactables', intent: 'reads' },
    ],
    plan: [
      { op: 'createInstance', path: 'Workspace.Interactables.Lever.Prompt', detail: 'ProximityPrompt' },
      { op: 'writeScript', path: 'ServerScriptService.InteractionService', detail: 'Script' },
      { op: 'writeScript', path: 'ServerScriptService.InteractionService.Handlers', detail: 'ModuleScript' },
    ],
  },
  {
    id: 'team-spawn',
    category: 'world',
    source: 'starter',
    keywords: ['team', 'spawn', 'balance', 'red', 'blue', 'teamcolor'],
    prompt: `Set up two teams with their own spawns.

Create Teams.Red and Teams.Blue with distinct TeamColor BrickColors and
AutoAssignable set to false.

Assume SpawnLocations at Workspace.Spawns.RedSpawn and Workspace.Spawns.BlueSpawn.
Set each one's TeamColor to match its team and Neutral to false, so the engine
routes respawns without any script running.

Create a Script at ServerScriptService.TeamService. On PlayerAdded it assigns the
player to whichever team currently has fewer players, breaking a tie in favour of
Red, then loads their character.

Team assignment happens on the server and there is no remote in this card. A
client asking to switch team is a feature, not this feature; if it is added later
it needs its own remote and its own balance check on the server side.`,
    scope: [
      { path: 'Teams.Red', intent: 'creates' },
      { path: 'Teams.Blue', intent: 'creates' },
      { path: 'Workspace.Spawns.RedSpawn', intent: 'writes' },
      { path: 'Workspace.Spawns.BlueSpawn', intent: 'writes' },
      { path: 'ServerScriptService.TeamService', intent: 'creates' },
    ],
    plan: [
      { op: 'createInstance', path: 'Teams.Red', detail: 'Team' },
      { op: 'createInstance', path: 'Teams.Blue', detail: 'Team' },
      { op: 'setProperty', path: 'Workspace.Spawns.RedSpawn', detail: 'TeamColor' },
      { op: 'setProperty', path: 'Workspace.Spawns.BlueSpawn', detail: 'TeamColor' },
      { op: 'writeScript', path: 'ServerScriptService.TeamService', detail: 'Script' },
    ],
  },
  {
    id: 'pet-follower',
    category: 'world',
    source: 'starter',
    keywords: ['pet', 'follow', 'companion', 'align', 'orientation'],
    prompt: `Add a pet that follows its owner.

Assume a pet model template at ServerStorage.Pets.Starter with a PrimaryPart that
is unanchored and has CanCollide set to false.

Create a Script at ServerScriptService.PetService. On CharacterAdded it clones the
template, parents it into Workspace, and drives it with an AlignPosition and an
AlignOrientation attached to an Attachment on the character's HumanoidRootPart,
offset behind and to the side. It cleans the pet up on CharacterRemoving and on
PlayerRemoving.

Use AlignPosition rather than setting CFrame every frame: a per-frame CFrame write
on the server replicates every frame to every client and is the single most common
cause of a laggy pet.

Set the pet's parts to CanCollide false and CanQuery false so it cannot push a
player off an obby or block a raycast.`,
    scope: [
      { path: 'ServerScriptService.PetService', intent: 'creates' },
      { path: 'ServerStorage.Pets.Starter', intent: 'reads' },
      { path: 'Workspace', intent: 'writes' },
    ],
    plan: [
      { op: 'writeScript', path: 'ServerScriptService.PetService', detail: 'Script' },
    ],
  },
  {
    id: 'datastore-save',
    category: 'persistence',
    source: 'starter',
    keywords: ['datastore', 'save', 'load', 'persistence', 'profile'],
    prompt: `Save and load player data.

Create a ModuleScript at ServerScriptService.DataService that wraps a DataStore
named "PlayerData_v1", keyed by "player_" .. UserId. It exposes Load(player),
Save(player) and Get(player), and holds an in-memory cache so no other system
touches the DataStore directly.

Create a Script at ServerScriptService.DataService.Lifecycle that calls Load on
PlayerAdded, Save on PlayerRemoving, Save for every remaining player on
game:BindToClose, and an autosave loop every 120 seconds with a small random
offset per player so the whole server does not write at once.

Every DataStore call goes through pcall and retries with backoff. A failed load
must mark the player's session as "do not save" and leave it that way, because
saving a default profile over a real one that merely failed to read is how
players lose everything they had. Say so in the code, not just in a comment on
the retry loop.

Version the stored table with a schema field so a later shape change can migrate
rather than overwrite.`,
    scope: [
      { path: 'ServerScriptService.DataService', intent: 'creates' },
      { path: 'ServerScriptService.DataService.Lifecycle', intent: 'creates' },
    ],
    plan: [
      { op: 'writeScript', path: 'ServerScriptService.DataService', detail: 'ModuleScript' },
      { op: 'writeScript', path: 'ServerScriptService.DataService.Lifecycle', detail: 'Script' },
    ],
  },
  {
    id: 'kill-brick',
    category: 'world',
    source: 'starter',
    keywords: ['kill', 'brick', 'lava', 'damage', 'touched'],
    prompt: `Add kill bricks.

Assume a Folder at Workspace.KillBricks containing BaseParts.

Create a Script at ServerScriptService.KillBrickService that connects Touched on
every part in that folder, now and as parts are added later, and applies damage
to the touching character's Humanoid.

Read the damage from a NumberValue named "Damage" inside each brick when one is
present, defaulting to the Humanoid's MaxHealth so a plain brick kills outright.

Guard the handler: resolve the character from the touching part, require a
Humanoid with Health above zero, and debounce per character for 0.3 seconds.
Touched fires continuously while a character stands on a part, and an
undebounced handler applies damage dozens of times per second.

Damage is applied on the server. There is no remote in this card.`,
    scope: [
      { path: 'ServerScriptService.KillBrickService', intent: 'creates' },
      { path: 'Workspace.KillBricks', intent: 'reads' },
    ],
    plan: [
      { op: 'writeScript', path: 'ServerScriptService.KillBrickService', detail: 'Script' },
    ],
  },
  {
    id: 'timed-door',
    category: 'interaction',
    source: 'starter',
    keywords: ['door', 'timer', 'open', 'close', 'button', 'tween'],
    prompt: `Add a door that opens on a button and closes itself.

Assume a door part at Workspace.Doors.GateA.Door and a button part at
Workspace.Doors.GateA.Button.

Create the ProximityPrompt at Workspace.Doors.GateA.Button.Prompt with an
ActionText of "Open".

Create a Script at ServerScriptService.DoorService. On Triggered it tweens the
door's CFrame to its open position, waits the number of seconds in a NumberValue
named "OpenSeconds" inside the gate model (defaulting to 5), then tweens it back
and re-enables the prompt.

Disable the prompt while the door is moving and while it is open, and track state
per door rather than in one shared variable — one boolean shared across every
gate in the place is a bug that only appears when two players use two doors at
once.

Re-check the distance on the server inside the Triggered handler, as with any
prompt: the client can fire Triggered from anywhere.`,
    scope: [
      { path: 'Workspace.Doors.GateA.Button.Prompt', intent: 'creates' },
      { path: 'ServerScriptService.DoorService', intent: 'creates' },
      { path: 'Workspace.Doors', intent: 'reads' },
    ],
    plan: [
      { op: 'createInstance', path: 'Workspace.Doors.GateA.Button.Prompt', detail: 'ProximityPrompt' },
      { op: 'writeScript', path: 'ServerScriptService.DoorService', detail: 'Script' },
    ],
  },
  {
    id: 'currency-pickup',
    category: 'economy',
    source: 'starter',
    keywords: ['coin', 'pickup', 'collect', 'respawn', 'currency'],
    prompt: `Add collectable coins that respawn.

Assume a Folder at Workspace.Coins containing BaseParts.

Create a Script at ServerScriptService.CoinService that connects Touched on every
coin. On a valid touch it grants Coins through
ServerScriptService.LeaderstatsService.Stats, hides the coin by setting
Transparency to 1 and CanCollide and CanTouch to false, waits the respawn delay,
and restores it.

Read the amount from a NumberValue named "Value" inside the coin when present,
defaulting to 1, and never from anything the client sends.

Guard the handler exactly as a kill brick guards its own: resolve the character,
require a live Humanoid, and mark the coin as taken *before* granting, so two
touches in the same frame cannot both pay out. Destroying and re-cloning a coin
each cycle churns the instance tree — hide and restore the same part instead.`,
    scope: [
      { path: 'ServerScriptService.CoinService', intent: 'creates' },
      { path: 'Workspace.Coins', intent: 'reads' },
      { path: 'ServerScriptService.LeaderstatsService.Stats', intent: 'reads' },
    ],
    plan: [
      { op: 'writeScript', path: 'ServerScriptService.CoinService', detail: 'Script' },
    ],
  },
  {
    id: 'round-timer',
    category: 'progression',
    source: 'starter',
    keywords: ['round', 'timer', 'match', 'intermission', 'countdown'],
    prompt: `Add a round loop with an intermission.

Create a ModuleScript at ReplicatedStorage.RoundState holding the phase names —
"Intermission", "Playing", "Ending" — and the durations, so client and server
read the same numbers from one place.

Create a Script at ServerScriptService.RoundService that runs the loop: an
intermission, a round, then an ending. It updates two values inside a Folder at
ReplicatedStorage.RoundStatus — a StringValue "Phase" and an IntValue
"SecondsLeft" — once per second.

Replicate the clock through those values rather than through a RemoteEvent fired
every second: a per-second remote to every player is traffic a Value object gives
you for free, and a late joiner reads the current state immediately instead of
waiting for the next tick.

The server owns the phase. A client reads RoundStatus and never writes to it.`,
    scope: [
      { path: 'ReplicatedStorage.RoundState', intent: 'creates' },
      { path: 'ReplicatedStorage.RoundStatus', intent: 'creates' },
      { path: 'ServerScriptService.RoundService', intent: 'creates' },
    ],
    plan: [
      { op: 'createInstance', path: 'ReplicatedStorage.RoundStatus', detail: 'Folder' },
      { op: 'createInstance', path: 'ReplicatedStorage.RoundStatus.Phase', detail: 'StringValue' },
      { op: 'createInstance', path: 'ReplicatedStorage.RoundStatus.SecondsLeft', detail: 'IntValue' },
      { op: 'writeScript', path: 'ReplicatedStorage.RoundState', detail: 'ModuleScript' },
      { op: 'writeScript', path: 'ServerScriptService.RoundService', detail: 'Script' },
    ],
  },
];

/** Sorted by id so the catalog order is a fact about the data, not about this file. */
export const CARDS: readonly MechanicCard[] = [...CARDS_DATA].sort((a, b) =>
  a.id.localeCompare(b.id, 'en'),
);

export function cardById(id: string): MechanicCard | undefined {
  return CARDS.find((card) => card.id === id);
}

/** Dictionary key for a card's translated field. One place, so it cannot drift. */
export function cardKey(id: string, field: 'title' | 'summary' | 'caveat'): string {
  return `inventory.cards.${id}.${field}`;
}
