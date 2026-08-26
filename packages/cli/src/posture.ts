import { PRIVACY_POSTURE, TransportKind } from '@forgebridge/protocol';
import { paint, type Io } from './output.js';

/**
 * Who can read what you just sent, printed on every command that reaches a
 * transport.
 *
 * ── Why the words come from the protocol and not from the response ───────────
 *
 * `GET /v1/link` answers with both a `transport` and a `privacyPosture` string,
 * and it would be one line shorter to print the string. That line is the whole
 * guarantee. The posture is a claim *about* a server, made *by* that server —
 * a relay operator who can read every ChangeSet crossing their box has both the
 * means and the motive to describe themselves as end-to-end encrypted, and a
 * client that renders whatever it is handed would repeat it in the operator's
 * own words.
 *
 * So the transport kind is the only thing taken from the wire, it is parsed
 * against the frozen `TransportKind` enum, and the sentence shown to the user is
 * looked up locally in `PRIVACY_POSTURE`. The mapping ships in the binary the
 * user installed; it cannot be edited by the thing being described.
 *
 * ── Why an unknown transport is not a blank line ─────────────────────────────
 *
 * A transport this build has never heard of gets an explicit refusal to vouch,
 * not silence and not a soothing default. Silence reads as "nothing to report",
 * which is precisely the wrong inference: the honest statement is that this
 * build cannot tell you who can read your changes, and that is worth a user
 * stopping over.
 */
export function postureSentence(transport: unknown): string {
  const parsed = TransportKind.safeParse(transport);
  if (!parsed.success) {
    return (
      'Unknown transport — this build cannot tell you who can read your changes. ' +
      'Update the CLI, or stop and check what you are connected to.'
    );
  }
  return PRIVACY_POSTURE[parsed.data];
}

/** True when the posture is the one that promises nothing leaves the machine. */
export function isLocalPosture(transport: unknown): boolean {
  const parsed = TransportKind.safeParse(transport);
  return parsed.success && parsed.data === 'local-daemon';
}

/**
 * Print the posture.
 *
 * On stderr, always — including under `--json`. A machine consumer redirects
 * stdout and would otherwise be the one caller that never sees this, and a
 * privacy notice suppressed by a flag is a privacy notice with an off switch.
 * `--quiet` does not exist for the same reason.
 */
export function printPosture(io: Io, transport: unknown): void {
  const sentence = postureSentence(transport);
  const local = isLocalPosture(transport);
  io.err(paint(io, local ? 'dim' : 'yellow', sentence));
}
