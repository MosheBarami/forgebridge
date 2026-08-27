import { LIMITS } from '@forgebridge/protocol';

/**
 * The numbers M45 is made of, in one place, so that a deployment can read what
 * it is enforcing without reading the router.
 *
 * Two kinds of number live here and they are not interchangeable:
 *
 *  - **Protocol limits** (`@forgebridge/protocol`'s `LIMITS`) are hard bounds
 *    on the wire. A ChangeSet past them is malformed and every transport
 *    refuses it.
 *  - **Relay ceilings** (below) are policy. They are lower, they are the
 *    operator's to raise or lower, and a ChangeSet that clears them is still
 *    subject to the protocol limit above.
 *
 * The relay ceilings are lower on purpose. The daemon's caller is the person
 * who started the daemon and is paying for their own machine; the relay's is a
 * stranger, and the relay is the only part of this system that costs the
 * project money (ADR-010). A ceiling equal to the protocol limit would be no
 * ceiling at all, which is why `assertCeilingsBelowProtocol` exists and is
 * exercised by `test/ceilings.test.ts`.
 */

export interface WindowLimit {
  /** Requests permitted inside the window. */
  limit: number;
  windowMs: number;
}

/**
 * Route classes, so the table in `routes.ts` names a policy rather than
 * repeating two numbers per route.
 *
 * A poll is the loosest by a wide margin and it should be: the plugin's whole
 * job is to hold one open, and a limit tuned for writes would throttle the one
 * request the transport exists to serve.
 */
export type LimitClass = 'session' | 'pair' | 'poll' | 'read' | 'write' | 'run';

export interface RelayLimits {
  /** Per source address, per class. */
  ip: Record<LimitClass, WindowLimit>;
  /** Per link, per class. Absent for classes that run before a link exists. */
  link: Record<LimitClass, WindowLimit>;
  /** Per-link ceilings on what one ChangeSet may be. */
  changeSet: {
    /** Serialised bytes. Below `LIMITS.MAX_CHANGESET_BYTES`. */
    maxBytes: number;
    /** Operation count. Below `LIMITS.MAX_OPERATIONS`. */
    maxOperations: number;
  };
  /** Bytes accepted on the routes that are not a ChangeSet. */
  maxRequestBytes: {
    pair: number;
    approve: number;
    rollback: number;
    output: number;
    run: number;
    session: number;
  };
  sponsored: {
    /**
     * The published number. ADR-010: "sponsored capacity is a published number,
     * not a mystery", and the breaker "degrades loudly, never silently". This
     * is the figure `GET /v1/health` reports and the figure a refusal quotes.
     */
    dailyBudget: number;
    /** Runs per verified user per UTC day. ADR-010 fixes this at 1. */
    perUserPerDay: number;
    /** Per source address per UTC day. */
    perIpPerDay: number;
    /** Per autonomous system per UTC day. */
    perAsnPerDay: number;
    /** Roblox account-age floor, in days (ADR-010). Enforced against M23's port. */
    minAccountAgeDays: number;
  };
}

const minute = 60_000;
const hour = 60 * minute;

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  ip: {
    // Minting a session is cheap for the relay and expensive to abuse in bulk:
    // each one is a live pairing code, and pairing codes are the thing a
    // guessing attack gets cheaper against as more of them exist.
    session: { limit: 20, windowMs: hour },
    // The bound on pairing-code guessing on this transport. `pairing.ts`
    // explains why the daemon's five-attempts-per-code does not transfer.
    pair: { limit: 30, windowMs: hour },
    poll: { limit: 600, windowMs: 5 * minute },
    read: { limit: 300, windowMs: minute },
    write: { limit: 120, windowMs: minute },
    run: { limit: 10, windowMs: hour },
  },
  link: {
    session: { limit: 20, windowMs: hour },
    pair: { limit: 10, windowMs: hour },
    poll: { limit: 400, windowMs: 5 * minute },
    read: { limit: 240, windowMs: minute },
    write: { limit: 60, windowMs: minute },
    run: { limit: 5, windowMs: hour },
  },
  changeSet: {
    maxBytes: 1_048_576,
    maxOperations: 200,
  },
  maxRequestBytes: {
    pair: 8 * 1024,
    approve: 16 * 1024,
    rollback: 16 * 1024,
    output: 512 * 1024,
    run: 256 * 1024,
    session: 8 * 1024,
  },
  sponsored: {
    dailyBudget: 200,
    perUserPerDay: 1,
    perIpPerDay: 1,
    perAsnPerDay: 1,
    minAccountAgeDays: 30,
  },
};

/**
 * A ceiling at or above the protocol's hard bound is not a ceiling.
 *
 * Checked at construction rather than trusted, because these numbers are
 * operator-supplied through the environment and a typo that adds a zero turns
 * the relay-specific defence off without changing anything visible. The
 * protocol limit still applies underneath — the set would be refused as
 * malformed — so the failure is not unbounded, but the *relay's* per-link
 * defence would be gone and nothing would say so.
 */
export function assertCeilingsBelowProtocol(limits: RelayLimits): void {
  if (limits.changeSet.maxBytes >= LIMITS.MAX_CHANGESET_BYTES) {
    throw new RangeError(
      `relay ceiling maxBytes=${limits.changeSet.maxBytes} is not below the protocol limit ` +
        `${LIMITS.MAX_CHANGESET_BYTES}; a ceiling at the hard bound enforces nothing`,
    );
  }
  if (limits.changeSet.maxOperations >= LIMITS.MAX_OPERATIONS) {
    throw new RangeError(
      `relay ceiling maxOperations=${limits.changeSet.maxOperations} is not below the protocol limit ` +
        `${LIMITS.MAX_OPERATIONS}; a ceiling at the hard bound enforces nothing`,
    );
  }
  if (limits.changeSet.maxBytes <= 0 || limits.changeSet.maxOperations <= 0) {
    throw new RangeError('relay ceilings must be positive');
  }
  for (const [scope, table] of Object.entries({ ip: limits.ip, link: limits.link })) {
    for (const [name, window] of Object.entries(table)) {
      if (window.limit <= 0 || window.windowMs <= 0) {
        throw new RangeError(`relay ${scope} limit "${name}" must have a positive limit and window`);
      }
    }
  }
  for (const [name, value] of Object.entries(limits.sponsored)) {
    if (typeof value === 'number' && value < 0) {
      throw new RangeError(`relay sponsored setting "${name}" must not be negative`);
    }
  }
}
