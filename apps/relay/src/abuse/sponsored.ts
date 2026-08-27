import { ForgeBridgeError } from '@forgebridge/protocol';
import type { AbuseStore } from './store.js';
import { utcDay } from './store.js';
import type { RelayLimits } from './limits.js';
import type { BudgetBreaker } from './budget.js';

/**
 * The sponsored run: one per day per verified user, and the only thing on this
 * relay that spends the project's money (ADR-010).
 *
 * ── The shape of every gate below ────────────────────────────────────────────
 *
 * Each step answers one question, and a step that cannot answer its question
 * REFUSES. Not "returns no opinion", not "passes because it found nothing to
 * object to" — refuses. Every bypass this repository has found so far had the
 * other shape: a check looked for a pattern, did not find one, and returned the
 * same answer it returns for safety. "I could not resolve this caller's network"
 * and "this caller's network is fine" are different facts and they get different
 * answers here.
 *
 * That is why an unwired verification port refuses everyone rather than waving
 * everyone through, and why an ASN that will not resolve is a refusal rather
 * than a two-out-of-three pass.
 *
 * ── Why all three counters ───────────────────────────────────────────────────
 *
 * ADR-010 requires per user AND per IP AND per ASN, and the three are not
 * redundant:
 *
 *  - **user** is the honest unit, and the one the promise is written in.
 *  - **IP** catches the same person with several accounts, which costs nothing
 *    to acquire.
 *  - **ASN** catches a caller cycling addresses inside one hosting provider,
 *    which is what someone does after they notice the IP counter. It is the
 *    only one of the three an attacker cannot buy their way around cheaply.
 *
 * All three must pass. Counting them as "any one of" would make the strictest
 * of the three irrelevant, which is the same as not having it.
 */

export interface VerifiedUser {
  /** Stable identifier for the verified account. Never an email or a name. */
  userId: string;
  /** How old the account is, for ADR-010's account-age floor. */
  accountAgeDays: number;
}

/**
 * Roblox OAuth verification, as a port.
 *
 * TODO(M23): the implementation. It is not this app's to write — M23 owns the
 * OAuth flow, the account-age read and the token custody, and a relay that
 * implemented them would be holding a client secret, which is the one thing
 * this app is defined by not holding.
 *
 * Its absence is a refusal rather than a default, and that is the whole point
 * of declaring it now: with no port wired, `verified()` cannot answer, so no
 * one is eligible for a sponsored run and the relay says exactly that. A relay
 * shipped ahead of M23 with this gate defaulting to "sure" would be a free,
 * unverified, sponsored-run endpoint on the public internet — the outcome
 * ADR-010 Option B was rejected for.
 */
export interface UserVerificationPort {
  /** Named in refusals, so an operator can tell which port answered. */
  readonly name: string;
  /**
   * Resolve the caller to a verified account, or `null` when the proof they
   * presented does not verify. Throwing is also a refusal — see `#verify`.
   */
  verify(input: { proof: string | undefined }): Promise<VerifiedUser | null>;
}

/**
 * Autonomous-system lookup, as a port.
 *
 * The relay cannot answer this itself: it needs a routing table or a
 * geolocation database, neither of which belongs in a pipe, and both of which
 * are a vendor dependency the self-hosting story cannot afford as a hard
 * requirement (ADR-004).
 *
 * TODO(M45): wire an implementation in the public deployment — a local MaxMind
 * ASN database or the platform's own edge metadata, whichever the host already
 * provides. Owner: whoever runs it.
 */
export interface AsnLookupPort {
  readonly name: string;
  /** The AS number as a string, or `null` when the address cannot be attributed. */
  lookup(address: string): Promise<string | null>;
}

export interface SponsoredRunReservation {
  user: VerifiedUser;
  asn: string;
  day: string;
  /** Give every counter back. Called when the run never happened. */
  release(): Promise<void>;
}

export interface SponsoredGateOptions {
  store: AbuseStore;
  limits: RelayLimits;
  budget: BudgetBreaker;
  verification?: UserVerificationPort | undefined;
  asn?: AsnLookupPort | undefined;
  now?: () => number;
}

export class SponsoredRunGate {
  readonly #store: AbuseStore;
  readonly #limits: RelayLimits;
  readonly #budget: BudgetBreaker;
  readonly #verification: UserVerificationPort | undefined;
  readonly #asn: AsnLookupPort | undefined;
  readonly #now: () => number;

  constructor(options: SponsoredGateOptions) {
    this.#store = options.store;
    this.#limits = options.limits;
    this.#budget = options.budget;
    this.#verification = options.verification;
    this.#asn = options.asn;
    this.#now = options.now ?? Date.now;
  }

  /** Whether a sponsored run can be granted to anyone on this relay at all. */
  get available(): boolean {
    return this.#verification !== undefined && this.#asn !== undefined;
  }

  /**
   * Take one sponsored run, or refuse.
   *
   * Reservations are taken in order and released in reverse on any later
   * failure, so a caller refused by the third counter has not silently spent
   * the first two. This is the part that decides whether "1 per day" is true
   * under concurrency: the counters are the authority, not a value read before
   * the decision.
   */
  async reserve(input: { address: string; proof: string | undefined }): Promise<SponsoredRunReservation> {
    const user = await this.#verify(input.proof);
    const asn = await this.#resolveAsn(input.address);
    const day = utcDay(this.#now());

    const taken: Array<() => Promise<void>> = [];
    const unwind = async (): Promise<void> => {
      // Reverse order, so a store that serialises writes sees them undone in
      // the order it saw them made.
      for (const release of taken.reverse()) await release();
    };

    const claim = async (key: string, limit: number, refusal: () => ForgeBridgeError): Promise<void> => {
      const ok = await this.#store.reserveDaily(key, day, limit);
      if (!ok) {
        await unwind();
        throw refusal();
      }
      taken.push(() => this.#store.releaseDaily(key, day));
    };

    // The global breaker first: when the day's budget is gone it is gone for
    // everyone, and charging a user's personal counter on the way to telling
    // them so would cost them tomorrow's run for a run they never got.
    const reservedBudget = await this.#budget.reserve();
    taken.push(reservedBudget.release);

    await claim(`relay:sponsored:user:${user.userId}`, this.#limits.sponsored.perUserPerDay, () =>
      exhausted(
        `you have already used your sponsored run for ${day}`,
        this.#limits.sponsored.perUserPerDay,
        'per verified account',
      ),
    );
    await claim(`relay:sponsored:ip:${input.address}`, this.#limits.sponsored.perIpPerDay, () =>
      exhausted(
        `this address has already used its sponsored run for ${day}`,
        this.#limits.sponsored.perIpPerDay,
        'per address',
      ),
    );
    await claim(`relay:sponsored:asn:${asn}`, this.#limits.sponsored.perAsnPerDay, () =>
      exhausted(
        `network AS${asn} has already used its sponsored run for ${day}`,
        this.#limits.sponsored.perAsnPerDay,
        'per network',
      ),
    );

    return { user, asn, day, release: unwind };
  }

  /**
   * Resolve the caller to a verified account, or refuse.
   *
   * A port that throws is treated exactly as a port that returned `null`: an
   * identity provider that is down has told us nothing about this caller, and
   * "the verifier is unavailable" is not a reason to skip verification. It is
   * the reason it exists.
   */
  async #verify(proof: string | undefined): Promise<VerifiedUser> {
    const port = this.#verification;
    if (!port) {
      throw new ForgeBridgeError(
        'provider_unconfigured',
        'this relay has no account verification wired in, so it can grant no sponsored runs',
        'Use your own API key (BYOK) or the local daemon. Sponsored runs need Roblox account ' +
          'verification (M23), which this deployment has not configured.',
      );
    }

    let verified: VerifiedUser | null;
    try {
      verified = await port.verify({ proof });
    } catch {
      verified = null;
    }

    if (!verified) {
      throw unverified(`${port.name} could not verify this caller's Roblox account`);
    }
    if (verified.accountAgeDays < this.#limits.sponsored.minAccountAgeDays) {
      throw unverified(
        `sponsored runs require a Roblox account at least ${this.#limits.sponsored.minAccountAgeDays} days old`,
      );
    }
    return verified;
  }

  /**
   * Attribute the caller to a network, or refuse.
   *
   * The refusal is the point. ADR-010 requires the ASN counter, so a request
   * the relay cannot attribute to a network is a request one of the three
   * required counters cannot be applied to — and granting it anyway would make
   * "all three required" mean "all three, unless the third is inconvenient",
   * which is precisely how a caller cycling addresses inside one provider gets
   * through. An unresolvable address is a finding, not a pass.
   */
  async #resolveAsn(address: string): Promise<string> {
    const port = this.#asn;
    if (!port) {
      throw new ForgeBridgeError(
        'provider_unconfigured',
        'this relay cannot attribute a request to a network, so it will not spend sponsored capacity',
        'Sponsored runs are counted per user, per address and per network (ADR-010). Wire an ASN ' +
          'lookup, or use BYOK or the local daemon, neither of which is counted at all.',
      );
    }
    let asn: string | null;
    try {
      asn = await port.lookup(address);
    } catch {
      asn = null;
    }
    if (!asn) {
      throw new ForgeBridgeError(
        'provider_unconfigured',
        `${port.name} could not attribute this address to a network, so no sponsored run was granted`,
        'This is a refusal, not an outage: sponsored capacity is only spent on requests the relay can ' +
          'account for. Use BYOK or the local daemon.',
      );
    }
    return asn;
  }
}

function exhausted(message: string, limit: number, unit: string): ForgeBridgeError {
  return new ForgeBridgeError(
    'budget_exhausted',
    `${message} — the sponsored allowance is ${limit} ${unit} per UTC day`,
    'Nothing was queued and nothing was downgraded. Use your own API key (BYOK) or the local daemon, ' +
      'which is not counted at all. The allowance resets at 00:00 UTC.',
  );
}

/**
 * An unverified caller.
 *
 * `policy_violation` is the least wrong code in a closed set that has none for
 * this. It is a 403, which is the right status, and its documented meaning —
 * "outside the project's allowed paths" — is narrower than what is happening
 * here, so the message carries the real reason.
 *
 * TODO(M31): an additive `unverified` code, so a client can branch on "prove
 * who you are" without reading English. This is the same gap
 * `packages/daemon/src/auth.ts` already records for producer-token failures,
 * which are reported as `link_unauthenticated` for want of anything better;
 * both want the same additive change. Owner: the protocol maintainer.
 */
function unverified(message: string): ForgeBridgeError {
  return new ForgeBridgeError(
    'policy_violation',
    message,
    'Sponsored runs are for verified Roblox accounts (ADR-010). Use your own API key (BYOK) or the ' +
      'local daemon, neither of which requires verification.',
  );
}
