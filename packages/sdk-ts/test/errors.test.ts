/**
 * `describeError` is the function every caller of this SDK ends up needing and
 * nobody wants to write. Two properties make it usable, and both are checked
 * here rather than asserted in a comment.
 *
 * It is **total**: every input returns a view and none raises. A classifier that
 * can fail is one a caller cannot use inside the `catch` block that is the only
 * place it is ever called.
 *
 * And `recognised` is **false whenever the answer was defaulted**. Reporting an
 * unreachable daemon as `internal` is correct; reporting it as `not_approved`
 * would be this SDK inventing an approval decision out of a socket timeout,
 * which is the one mistake in this area that is worse than having no classifier.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode, ForgeBridgeError } from '@forgebridge/protocol';
import { ForgeBridgeResponseError, TransportError, describeError } from '../src/index.js';

const CODES = ErrorCode.options;

describe('every protocol code survives the round trip', () => {
  it('reads a thrown ForgeBridgeError', () => {
    for (const code of CODES) {
      const view = describeError(new ForgeBridgeError(code, `${code} happened`, 'do the thing'));
      expect(view.code).toBe(code);
      expect(view.recognised).toBe(true);
      expect(view.remedy).toBe('do the thing');
    }
  });

  it('reads a raw ProtocolError payload, as it arrives off a wire this package did not read', () => {
    // The conformance suite feeds every code twice — thrown, and as the JSON the
    // daemon actually sends. A classifier that only understands its own
    // exception type has a mapping that works in its own tests and nowhere else.
    for (const code of CODES) {
      const view = describeError({ code, message: `${code} happened` });
      expect(view.code).toBe(code);
      expect(view.recognised).toBe(true);
    }
  });

  it('keeps the status the answer actually arrived with', () => {
    const view = describeError(
      new ForgeBridgeResponseError({ code: 'policy_violation', message: 'outside the allowlist' }, 403),
    );
    expect(view).toMatchObject({ code: 'policy_violation', recognised: true, httpStatus: 403 });
  });
});

describe('a failure that is not a protocol answer is not reported as one', () => {
  it('reports a transport failure as internal, and says it was not recognised', () => {
    const view = describeError(new TransportError('no daemon answered at http://127.0.0.1:7317'));
    expect(view.code).toBe('internal');
    expect(view.recognised).toBe(false);
    expect(view.remedy).toMatch(/did not produce a \/v1 answer/);
  });

  it('does not recognise a code the protocol does not define', () => {
    // A body that looks like a ProtocolError and carries a code from somewhere
    // else is not one. Accepting it would put a value in `view.code` that no
    // caller's branch matches.
    const view = describeError({ code: 'teapot', message: 'short and stout' });
    expect(view.code).toBe('internal');
    expect(view.recognised).toBe(false);
  });

  it('is total over everything else, and raises for nothing', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      'a string',
      42,
      {},
      [],
      new Error('an ordinary error'),
      { code: 'stale_base' }, // no message: not a ProtocolError
      Symbol('opaque'),
    ];
    for (const input of inputs) {
      const view = describeError(input);
      expect(view.code).toBe('internal');
      expect(view.recognised).toBe(false);
      expect(typeof view.message).toBe('string');
    }
  });
});
