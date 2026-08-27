import { SERVICE_ROOTS } from '@forgebridge/protocol';
import type { EdgeKind } from './model';

/**
 * Reading the edges out of Luau text.
 *
 * What this is: a small, deliberate scanner that resolves the instance-chain
 * expressions Roblox code is actually written with — `game:GetService("X")`,
 * `:WaitForChild("Y")`, `script.Parent.Z`, `local Remotes = …` — into dotted
 * paths, and reports two kinds of relationship between scripts:
 *
 *   require   `require(<chain>)`
 *   remote    `<chain>:FireServer(…)`, `<chain>.OnServerEvent:Connect(…)`, and
 *             the rest of the remote surface
 *
 * What it is emphatically **not**: an evaluator. It reads what a script *says*,
 * not what it *computes*. A reference assembled at runtime —
 * `Remotes[name .. "Request"]`, a module returned from a table, a path read from
 * an attribute — produces no edge here and cannot. That limitation is printed on
 * the surface, next to the graph, because a map that quietly omits half a
 * codebase's wiring is worse than no map: the first one you trust.
 *
 * The same posture as `packages/luau-analysis`, which says it "recognises what a
 * script says, not what it computes" — and for the same reason. A parser that
 * pretended otherwise would be a Luau interpreter, and this is a diagram.
 *
 * Every edge carries the text that produced it (`evidence`), so a wrong edge is
 * traceable to a line rather than to a black box.
 */

export interface RawReference {
  readonly kind: EdgeKind;
  /** Dotted path, or `null` when the chain could not be resolved. */
  readonly target: string | null;
  /** The matched text, trimmed and capped. Rendered mono in the node panel. */
  readonly evidence: string;
}

/** Calls whose string argument names a child, so they extend a chain. */
const CHILD_CALLS = new Set(['WaitForChild', 'FindFirstChild', 'GetService']);

/** Methods that identify the chain before them as a remote. */
const REMOTE_METHODS = new Set([
  'FireServer',
  'FireClient',
  'FireAllClients',
  'InvokeServer',
  'InvokeClient',
]);

/** Members that identify the chain before them as a remote, via `:Connect`. */
const REMOTE_MEMBERS = new Set([
  'OnServerEvent',
  'OnClientEvent',
  'OnServerInvoke',
  'OnClientInvoke',
]);

const IDENT = /[A-Za-z_]\w*/y;
const SAFE_SEGMENT = /^[A-Za-z_]\w*$/;

interface Chain {
  /** Resolved-in-order name segments, before any trailing method call. */
  readonly segments: readonly string[];
  /** The `:Method` the chain ended in, if it ended in one. */
  readonly method: string | null;
  readonly start: number;
  readonly end: number;
}

/**
 * Strip comments, keeping every other byte at its own offset.
 *
 * Offsets are preserved — comments become spaces of the same length — because
 * `evidence` slices the *original* source, and an evidence string that pointed
 * at the wrong place would defeat the purpose of carrying one.
 */
function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < out.length) {
    const two = source.slice(i, i + 2);
    if (two === '--') {
      // Long comment: --[[ … ]] or --[=[ … ]=]
      const long = /^--\[(=*)\[/.exec(source.slice(i));
      if (long) {
        const close = `]${long[1] ?? ''}]`;
        const end = source.indexOf(close, i + long[0].length);
        const stop = end === -1 ? out.length : end + close.length;
        for (let j = i; j < stop; j += 1) if (out[j] !== '\n') out[j] = ' ';
        i = stop;
        continue;
      }
      let j = i;
      while (j < out.length && out[j] !== '\n') {
        out[j] = ' ';
        j += 1;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function skipSpace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i] as string)) i += 1;
  return i;
}

function readIdent(text: string, index: number): { value: string; next: number } | null {
  IDENT.lastIndex = index;
  const match = IDENT.exec(text);
  if (!match || match.index !== index) return null;
  return { value: match[0], next: index + match[0].length };
}

/** `("Name")` after a child-yielding call. Single or double quoted, no escapes. */
function readStringCall(text: string, index: number): { value: string; next: number } | null {
  let i = skipSpace(text, index);
  if (text[i] !== '(') return null;
  i = skipSpace(text, i + 1);
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  const close = text.indexOf(quote, i + 1);
  if (close === -1) return null;
  const value = text.slice(i + 1, close);
  i = skipSpace(text, close + 1);
  if (text[i] !== ')') return null;
  return { value, next: i + 1 };
}

/** `["Name"]`. */
function readBracket(text: string, index: number): { value: string; next: number } | null {
  let i = skipSpace(text, index);
  if (text[i] !== '[') return null;
  i = skipSpace(text, i + 1);
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  const close = text.indexOf(quote, i + 1);
  if (close === -1) return null;
  const value = text.slice(i + 1, close);
  i = skipSpace(text, close + 1);
  if (text[i] !== ']') return null;
  return { value, next: i + 1 };
}

/**
 * Every instance-chain expression in the text, in source order.
 *
 * A chain starts at an identifier that is not itself part of a longer chain (the
 * preceding non-space character is not `.`, `:` or an identifier character), and
 * extends through `.Name`, `["Name"]`, `:WaitForChild("Name")`,
 * `:FindFirstChild("Name")` and `:GetService("Name")`. Any other `:Method` ends
 * the chain and is recorded as `method`.
 */
function chainsIn(text: string): Chain[] {
  const found: Chain[] = [];
  let i = 0;

  while (i < text.length) {
    const head = readIdent(text, i);
    if (!head) {
      i += 1;
      continue;
    }

    const before = text[i - 1];
    if (before !== undefined && /[\w.:]/.test(before)) {
      i = head.next;
      continue;
    }

    const segments: string[] = [head.value];
    let cursor = head.next;
    let method: string | null = null;

    for (;;) {
      const after = skipSpace(text, cursor);
      const ch = text[after];

      if (ch === '.') {
        const ident = readIdent(text, skipSpace(text, after + 1));
        if (!ident) break;
        segments.push(ident.value);
        cursor = ident.next;
        continue;
      }

      if (ch === '[') {
        const bracket = readBracket(text, after);
        if (!bracket) break;
        segments.push(bracket.value);
        cursor = bracket.next;
        continue;
      }

      if (ch === ':') {
        const ident = readIdent(text, skipSpace(text, after + 1));
        if (!ident) break;
        if (CHILD_CALLS.has(ident.value)) {
          const call = readStringCall(text, ident.next);
          if (!call) break;
          segments.push(call.value);
          cursor = call.next;
          continue;
        }
        method = ident.value;
        cursor = ident.next;
        break;
      }

      break;
    }

    found.push({ segments, method, start: i, end: cursor });
    i = cursor > i ? cursor : i + 1;
  }

  return found;
}

interface ResolveContext {
  /** The path of the script the text belongs to, for `script.Parent…`. */
  readonly selfPath: string;
  readonly aliases: ReadonlyMap<string, string>;
}

function isServiceRoot(name: string): boolean {
  return (SERVICE_ROOTS as readonly string[]).includes(name);
}

/**
 * A chain's segments into a dotted path, or `null` when it cannot be known.
 *
 * `null` is a first-class answer, not a failure to try harder: `Remotes[name]`
 * genuinely does not name a path, and inventing one would put a line on a
 * diagram that is not in the code.
 */
export function resolveChain(segments: readonly string[], context: ResolveContext): string | null {
  const [head, ...rest] = segments;
  if (head === undefined) return null;

  let parts: string[];

  if (head === 'game') {
    // `game.ReplicatedStorage` and `game:GetService("ReplicatedStorage")` both
    // arrive here as ['game', 'ReplicatedStorage', …].
    const service = rest[0];
    if (service === undefined || !isServiceRoot(service)) return null;
    parts = [service];
    rest.shift();
  } else if (head === 'workspace') {
    parts = ['Workspace'];
  } else if (head === 'script') {
    parts = context.selfPath.split('.');
  } else if (context.aliases.has(head)) {
    parts = (context.aliases.get(head) as string).split('.');
  } else if (isServiceRoot(head)) {
    // A bare service name that was never assigned in this file. Roblox does not
    // make these globals, so this is a file that got its alias from somewhere
    // this scanner cannot see — but the intent is unambiguous enough to draw.
    parts = [head];
  } else {
    return null;
  }

  for (const segment of rest) {
    if (segment === 'Parent') {
      parts = parts.slice(0, -1);
      if (parts.length === 0) return null;
      continue;
    }
    if (!SAFE_SEGMENT.test(segment)) return null;
    parts = [...parts, segment];
  }

  if (parts.length === 0) return null;
  if (!isServiceRoot(parts[0] as string)) return null;
  return parts.join('.');
}

/** `local X = <chain>` — so the next chain that starts with `X` can resolve. */
const LOCAL_ASSIGN = /\b(?:local\s+)?([A-Za-z_]\w*)\s*=\s*/g;

function evidenceFor(source: string, start: number, end: number): string {
  const text = source.slice(start, Math.min(end + 24, source.length)).split('\n')[0] ?? '';
  const trimmed = text.trim();
  return trimmed.length > 96 ? `${trimmed.slice(0, 95)}…` : trimmed;
}

/**
 * Every reference one script's text makes.
 *
 * Aliases are resolved in source order, so a chain can depend on an assignment
 * above it — which is how every Roblox file is written:
 *
 *     local ReplicatedStorage = game:GetService("ReplicatedStorage")
 *     local Remotes = ReplicatedStorage:WaitForChild("Remotes")
 *     Remotes.PurchaseItem.OnServerInvoke = handle
 *
 * Reassignment inside a loop, shadowing in a nested scope, and a chain that
 * depends on an assignment *below* it are all wrong here. They are also all
 * unusual in the shape of code this reads, and the alternative is a scope-aware
 * Luau parser, which is a different project.
 */
export function referencesIn(selfPath: string, source: string): RawReference[] {
  const text = blankComments(source);
  const aliases = new Map<string, string>();
  const references: RawReference[] = [];

  // Positions where an assignment's right-hand side begins, and the name it
  // binds. Collected up front so the single chain walk below can consult them.
  const assignAt = new Map<number, string>();
  LOCAL_ASSIGN.lastIndex = 0;
  for (let match = LOCAL_ASSIGN.exec(text); match !== null; match = LOCAL_ASSIGN.exec(text)) {
    assignAt.set(match.index + match[0].length, match[1] as string);
  }

  // `require(` positions, so a chain starting immediately after one is a
  // require. The value is where the `require` keyword itself began, so the
  // evidence can quote the whole call rather than the bare chain inside it —
  // `require(ReplicatedStorage.ShopCatalog)` is a line somebody can find in a
  // file, and `ReplicatedStorage.ShopCatalog)` is a fragment.
  const requireAt = new Map<number, number>();
  const requireRe = /\brequire\s*\(\s*/g;
  for (let match = requireRe.exec(text); match !== null; match = requireRe.exec(text)) {
    requireAt.set(match.index + match[0].length, match.index);
  }

  for (const chain of chainsIn(text)) {
    const context: ResolveContext = { selfPath, aliases };

    // A remote is identified by its trailing method or its trailing member; in
    // both cases the *chain* is everything before that.
    const last = chain.segments[chain.segments.length - 1];
    const isRemoteMember = last !== undefined && REMOTE_MEMBERS.has(last);
    const isRemoteMethod = chain.method !== null && REMOTE_METHODS.has(chain.method);
    const target = isRemoteMember ? chain.segments.slice(0, -1) : chain.segments;

    if (isRemoteMember || isRemoteMethod) {
      references.push({
        kind: 'remote',
        target: resolveChain(target, context),
        evidence: evidenceFor(source, chain.start, chain.end),
      });
      continue;
    }

    const requireStart = requireAt.get(chain.start);
    if (requireStart !== undefined) {
      references.push({
        kind: 'require',
        target: resolveChain(chain.segments, context),
        evidence: evidenceFor(source, requireStart, chain.end),
      });
      continue;
    }

    const bound = assignAt.get(chain.start);
    if (bound !== undefined && chain.method === null) {
      const resolved = resolveChain(chain.segments, context);
      if (resolved !== null) aliases.set(bound, resolved);
    }
  }

  return references;
}
