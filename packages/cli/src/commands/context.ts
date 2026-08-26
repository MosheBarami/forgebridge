import type { Transport } from '../client.js';
import type { Io } from '../output.js';
import type { GlobalOptions } from '../args.js';

/**
 * What a command is given.
 *
 * Commands never construct a transport, read `process.env`, or touch
 * `process.exit`. All three arrive here, which is what lets every command be
 * driven by a test with a stub transport and a captured `Io` — including the
 * one test that matters most, that `apply` refuses an unapproved changeset and
 * makes no call that could approve it.
 */
export interface Deps {
  io: Io;
  /** Built once per invocation from the resolved global options. */
  createTransport(global: GlobalOptions): Transport;
  /** Wall clock, injectable so relative timestamps are testable. */
  now(): number;
  /** Cooperative delay, injectable so `apply`'s poll loop does not sleep in tests. */
  sleep(ms: number): Promise<void>;
}
