import type { ChangeSetDiff } from '@forgebridge/daemon';
import type { Invocation } from '../args.js';
import { EXIT, type ExitCode } from '../exit.js';
import { emitJson, paint, truncate, type Io } from '../output.js';
import { printPosture } from '../posture.js';
import type { Deps } from './context.js';

/**
 * `forgebridge diff <changeset-id>` — what this set would do, before it does it.
 *
 * The rendering is the transport's, not this command's: `ChangeSetDiff` already
 * carries a per-operation summary, the paths each operation touches, and a
 * `destructive` flag, all computed by the side that owns the ChangeSet. A
 * connector that re-derived any of that would be a second opinion drifting from
 * the first (ADR-009), and the one that mattered — which paths an operation
 * really reaches, including references buried in property bags — is exactly the
 * computation `pathsOf` exists to get right in one place.
 */
export async function diffCommand(
  invocation: Extract<Invocation, { command: 'diff' }>,
  deps: Deps,
): Promise<ExitCode> {
  const transport = deps.createTransport(invocation.global);
  const { io } = deps;

  const link = await transport.linkStatus();
  printPosture(io, link.transport);

  const diff = await transport.diff(invocation.changeSetId);

  if (invocation.global.json) {
    emitJson(io, diff);
    return EXIT.OK;
  }

  io.out(`changeset  ${diff.changeSetId}`);
  io.out(`summary    ${diff.summary}`);
  io.out(`status     ${diff.status}`);
  io.out(
    `version    built against ${diff.baseVersion}, project is at ${diff.currentVersion}${
      diff.stale ? paint(io, 'yellow', ' — stale, must be rebased and resubmitted') : ''
    }`,
  );
  io.out(
    `operations ${diff.counts.total}: ${diff.counts.creates} create, ${diff.counts.setProperties} property, ${diff.counts.scripts} script, ${diff.counts.moves} move, ${diff.counts.deletes} delete`,
  );

  printValidation(io, diff);

  io.out('');
  for (const operation of diff.operations) {
    const marker = operation.destructive ? paint(io, 'red', '!') : ' ';
    const index = String(operation.index).padStart(3);
    io.out(`${marker} ${index}  ${operation.op}  ${operation.summary}`);
    if (operation.paths.length > 1) {
      // More than one path means the operation reaches somewhere its own `path`
      // does not name — a move's destination, or a reference inside a property
      // bag. Those are the paths a policy allowlist has to see, so they are the
      // paths a reviewer should see too.
      io.out(`         touches: ${operation.paths.join(', ')}`);
    }
    if (operation.after !== undefined) {
      io.out(paint(io, 'dim', `         after: ${truncate(operation.after, 100)}`));
    }
  }

  if (diff.counts.deletes > 0) {
    io.err(
      paint(io, 'yellow', `${diff.counts.deletes} operation(s) marked ! destroy work that is there now.`),
    );
  }

  // Stated because the field is on the wire and a reader would otherwise assume
  // the "after" values were diffed against something. They were not: the daemon
  // holds no tree snapshot, so it can say what an operation will write and not
  // what was there before.
  if (!diff.treeAware) {
    io.err(
      paint(
        io,
        'dim',
        'This transport holds no tree snapshot, so values are shown as "after" only — there is nothing here to diff them against.',
      ),
    );
  }

  return EXIT.OK;
}

function printValidation(io: Io, diff: ChangeSetDiff): void {
  if (!diff.validation) {
    // Absence is reportable state and is not the same as a clean verdict. A
    // ChangeSet with no validation cannot be approved, and saying nothing here
    // would let a reader assume it passed.
    io.out(`validation ${paint(io, 'yellow', 'none computed')} — this set cannot be approved as it stands`);
    return;
  }

  const { luau, policy } = diff.validation;
  const tint = (status: string): string =>
    paint(io, status === 'ok' ? 'green' : status === 'warn' ? 'yellow' : 'red', status);

  io.out(`validation luau ${tint(luau.status)}, policy ${tint(policy.status)}`);
  io.out(paint(io, 'dim', `           computed by ${diff.validation.computedBy} at ${diff.validation.computedAt}`));

  for (const finding of luau.findings) {
    const where = finding.operationIndex === undefined ? '' : ` (operation ${finding.operationIndex})`;
    io.out(`           ${finding.severity} ${finding.rule}: ${finding.message}${where}`);
  }
  for (const violation of policy.violations) {
    io.out(`           policy: ${violation}`);
  }
}
