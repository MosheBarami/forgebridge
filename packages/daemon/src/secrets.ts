import { execFile } from 'node:child_process';
import { platform } from 'node:process';
import type { SecretRef, SecretScope, SecretsBackendInfo, SecretsPort } from '@forgebridge/core';

/**
 * Where the daemon reads a provider credential from (ADR-006, C4).
 *
 * The core reaches a credential through `SecretsPort` and through nothing else,
 * so this file is the whole of the daemon's answer to "where is the key". Two
 * backends, both read paths, and a chain that tries them in order:
 *
 *   - the environment, because an operator who exported a variable has said
 *     plainly where the key is and expects that to win; and
 *   - the OS keychain, because a variable in a shell profile is readable by
 *     every process this user runs, which `describe()` reports rather than
 *     hides.
 *
 * Nothing here writes a value anywhere. The daemon does not persist a key
 * (`scripts/verify-no-key-storage.ts` K4 is the gate that says so), it does not
 * log one, and it does not put one in a response — the only thing it does with
 * a credential is hand it to the adapter that is about to make one HTTPS
 * request with it.
 */

/** The environment variable a scope and a name are read from, in a fixed form. */
export function environmentVariableName(ref: SecretRef): string {
  return `FORGEBRIDGE_${ref.scope}_${ref.name}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Names a provider's own tooling already uses, accepted so a user who has
 * exported the variable their other tools read does not have to export a second
 * one under our name to say the same thing.
 *
 * Keyed by scope and then by the name inside it — the same two-part address
 * `SecretRef` carries, so there is no third naming convention to remember.
 */
export const WELL_KNOWN_VARIABLE_NAMES: Readonly<Record<string, readonly string[]>> = {
  'provider:openrouter': ['OPENROUTER_API_KEY'],
};

/** Every variable consulted for a ref, in precedence order. */
export function candidateVariableNames(ref: SecretRef): string[] {
  return [
    environmentVariableName(ref),
    ...(WELL_KNOWN_VARIABLE_NAMES[`${ref.scope}:${ref.name}`] ?? []),
  ];
}

const READ_ONLY_REMEDY =
  'This backend reads; it does not write. Export the variable, or add the item to the OS keychain yourself.';

/**
 * Environment-variable backend.
 *
 * `readableByOtherProcesses` is true and says so in the UI, because it is: a
 * variable exported into a shell is visible to everything that shell starts,
 * and on Linux to anything that can read `/proc/<pid>/environ` for this user.
 * Reporting that plainly is the same decision `PRIVACY_POSTURE` makes for the
 * transports — one padlock for every backend would be the lie.
 */
export class EnvironmentSecrets implements SecretsPort {
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(environment: Readonly<Record<string, string | undefined>> = process.env) {
    this.#environment = environment;
  }

  async get(ref: SecretRef): Promise<string | null> {
    for (const name of candidateVariableNames(ref)) {
      const value = this.#environment[name]?.trim();
      if (value) return value;
    }
    return null;
  }

  async set(_ref: SecretRef, _value: string): Promise<void> {
    // A process cannot export a variable into the shell that started it, and
    // pretending otherwise — by setting `process.env` and returning — would
    // report a credential as stored when it will not survive the next restart.
    throw new Error(`the environment secrets backend cannot store a value. ${READ_ONLY_REMEDY}`);
  }

  async delete(_ref: SecretRef): Promise<void> {
    throw new Error(`the environment secrets backend cannot remove a value. ${READ_ONLY_REMEDY}`);
  }

  /**
   * Names only, never values — the port offers no bulk read for the reason
   * `ports/secrets.ts` gives, and this method must not become one by accident.
   * Variable *keys* are read; nothing is dereferenced.
   */
  async listNames(scope: SecretScope): Promise<string[]> {
    const prefix = `FORGEBRIDGE_${scope.toUpperCase()}_`;
    const found = new Set<string>();
    for (const [name, value] of Object.entries(this.#environment)) {
      if (!value?.trim()) continue;
      if (name.startsWith(prefix)) found.add(name.slice(prefix.length).toLowerCase());
    }
    for (const [address, names] of Object.entries(WELL_KNOWN_VARIABLE_NAMES)) {
      const [refScope, refName] = address.split(':');
      if (refScope !== scope || refName === undefined) continue;
      if (names.some((name) => this.#environment[name]?.trim())) found.add(refName);
    }
    return [...found].sort();
  }

  describe(): SecretsBackendInfo {
    return { kind: 'env', label: 'environment variables', readableByOtherProcesses: true };
  }
}

/** Exit status `security` uses for `errSecItemNotFound`. Absence is not an error. */
const SECURITY_ITEM_NOT_FOUND = 44;
const SECURITY_TIMEOUT_MS = 10_000;
const MAX_STDERR_CHARS = 200;

/**
 * macOS Keychain backend, over the `security` binary that ships with the OS.
 *
 * A CLI rather than a native binding on purpose: a native keychain module is a
 * compiled dependency in a package a user is asked to run on their own machine,
 * and `npm install` printing a compiler error is how a local-first tool stops
 * being installed. The cost is a process spawn per read, which happens once per
 * run and not once per token.
 *
 * **Read-only, deliberately.** `security add-generic-password` takes the value
 * either as an argv element — where every process on the machine can read it
 * out of `ps` for as long as the call lasts — or by prompting for it, and its
 * own help calls the first form insecure. Writing a credential through the
 * insecure form to save the user one command would be this file undoing its own
 * reason to exist, and the prompting form's behaviour on a piped stdin is not
 * something this package has verified on a real machine.
 *
 * TODO(M38): key management is M38's row, and it is where a verified write path
 * belongs — including the Windows Credential Manager and libsecret backends
 * `docs/ARCHITECTURE.md` names beside this one. Until then `set` and `delete`
 * say what to run instead of quietly doing something weaker.
 */
export class KeychainSecrets implements SecretsPort {
  readonly #run: (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  readonly #knownNames: Readonly<Record<string, readonly string[]>>;

  /**
   * @param knownNames names to probe per scope in `listNames`. The keychain has
   *   no "list every account under this service" that does not amount to
   *   dumping the whole keychain, so enumeration is a probe over names this
   *   daemon already knows about rather than a search.
   */
  constructor(
    options: {
      run?: (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
      knownNames?: Readonly<Record<string, readonly string[]>>;
    } = {},
  ) {
    this.#run = options.run ?? runSecurity;
    this.#knownNames = options.knownNames ?? { provider: ['openrouter'] };
  }

  /** True when this platform has the binary this backend drives. */
  static available(): boolean {
    return platform === 'darwin';
  }

  async get(ref: SecretRef): Promise<string | null> {
    const result = await this.#run(['find-generic-password', '-s', serviceFor(ref), '-a', ref.name, '-w']);
    if (result.code === SECURITY_ITEM_NOT_FOUND) return null;
    if (result.code !== 0) {
      // The stderr of `security` names the service and the account, never the
      // stored value, so it is safe to carry — clipped, because an unbounded
      // message from a subprocess is a caller choosing the size of our error.
      throw new Error(
        `security find-generic-password failed (${result.code}): ${result.stderr.trim().slice(0, MAX_STDERR_CHARS)}`,
      );
    }
    // `-w` prints the value and a newline and nothing else. Trailing whitespace
    // is stripped; nothing inside is touched.
    const value = result.stdout.replace(/\r?\n$/, '');
    return value.length > 0 ? value : null;
  }

  async set(ref: SecretRef, _value: string): Promise<void> {
    throw new Error(
      `this keychain backend does not write. Run: security add-generic-password -U ` +
        `-s ${serviceFor(ref)} -a ${ref.name} -w   (as the last option, so it prompts)`,
    );
  }

  async delete(ref: SecretRef): Promise<void> {
    throw new Error(
      `this keychain backend does not write. Run: security delete-generic-password ` +
        `-s ${serviceFor(ref)} -a ${ref.name}`,
    );
  }

  async listNames(scope: SecretScope): Promise<string[]> {
    const present: string[] = [];
    for (const name of this.#knownNames[scope] ?? []) {
      const found = await this.#run([
        'find-generic-password',
        '-s',
        serviceFor({ scope, name }),
        '-a',
        name,
      ]);
      // No `-w`: this asks whether the item exists and never reads its value.
      if (found.code === 0) present.push(name);
    }
    return present;
  }

  describe(): SecretsBackendInfo {
    return { kind: 'os-keychain', label: 'macOS Keychain', readableByOtherProcesses: false };
  }
}

/** `forgebridge.provider` — one service per scope, the account is the name. */
export function serviceFor(ref: SecretRef): string {
  return `forgebridge.${ref.scope}`;
}

function runSecurity(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      [...args],
      { timeout: SECURITY_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') {
          // No exit status means the binary never ran — missing, or killed by
          // the timeout. That is not "the item is absent", and reporting it as
          // absence would turn a broken keychain into a silently unconfigured
          // daemon.
          reject(error);
          return;
        }
        resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr });
      },
    );
  });
}

/**
 * Try each backend in order and take the first answer.
 *
 * Order is precedence: whatever the operator put in the environment wins over
 * whatever is in the keychain, because the environment is the explicit act.
 * `describe()` reports the first backend that could hold a value rather than
 * the one that happened to answer last, so the posture a UI shows does not
 * change under it between reads.
 */
export class LayeredSecrets implements SecretsPort {
  readonly #layers: readonly SecretsPort[];

  constructor(layers: readonly SecretsPort[]) {
    if (layers.length === 0) throw new Error('LayeredSecrets needs at least one backend');
    this.#layers = layers;
  }

  async get(ref: SecretRef): Promise<string | null> {
    for (const layer of this.#layers) {
      const found = await layer.get(ref);
      if (found !== null) return found;
    }
    return null;
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    await this.#layers[0]!.set(ref, value);
  }

  async delete(ref: SecretRef): Promise<void> {
    await this.#layers[0]!.delete(ref);
  }

  async listNames(scope: SecretScope): Promise<string[]> {
    const found = new Set<string>();
    for (const layer of this.#layers) {
      for (const name of await layer.listNames(scope)) found.add(name);
    }
    return [...found].sort();
  }

  describe(): SecretsBackendInfo {
    const first = this.#layers[0]!.describe();
    if (this.#layers.length === 1) return first;
    const labels = this.#layers.map((layer) => layer.describe().label).join(', then ');
    return {
      kind: first.kind,
      label: labels,
      // True if *any* layer is world-readable by this user's processes: the
      // weakest link is the posture, and reporting the strongest would be the
      // padlock this file refuses to draw.
      readableByOtherProcesses: this.#layers.some((layer) => layer.describe().readableByOtherProcesses),
    };
  }
}

/**
 * What the daemon uses when the process that started it did not say otherwise:
 * the environment, then the OS keychain where there is one this package can
 * read.
 */
export function defaultSecrets(): SecretsPort {
  const layers: SecretsPort[] = [new EnvironmentSecrets()];
  if (KeychainSecrets.available()) layers.push(new KeychainSecrets());
  return new LayeredSecrets(layers);
}
