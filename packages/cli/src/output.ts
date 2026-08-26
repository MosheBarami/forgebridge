/**
 * Writing to a terminal, or to whatever a pipeline redirected it into.
 *
 * Two rules drive everything here. Human output is the default because a person
 * at a shell is the common case; `--json` is exact because a script parsing
 * padded columns is a script that breaks on the first long model id. And colour
 * appears only on a TTY, because escape sequences in a CI log are noise that
 * survives into every bug report pasted out of it.
 */

const RESET = '\u001B[0m';

const CODES = {
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
  green: '\u001B[32m',
  cyan: '\u001B[36m',
} as const;

export type Colour = keyof typeof CODES;

export interface Io {
  /** The result. Redirect-safe: only this stream carries machine output. */
  out(text: string): void;
  /**
   * Everything that is not the result — posture lines, warnings, refusals.
   *
   * Keeping them off stdout is what lets `forgebridge models --json | jq` work
   * while the posture line is still shown to the human who ran it. A privacy
   * notice a pipe can silently swallow is a privacy notice that will be.
   */
  err(text: string): void;
  colour: boolean;
}

export function paint(io: Io, colour: Colour, text: string): string {
  return io.colour ? `${CODES[colour]}${text}${RESET}` : text;
}

/**
 * Whether to emit colour at all.
 *
 * `NO_COLOR` is honoured by presence, whatever its value — that is what the
 * convention says, and reading `NO_COLOR=0` as "yes please" would surprise
 * exactly the person who went looking for the switch.
 */
export function shouldUseColour(
  stream: { isTTY?: boolean | undefined },
  env: NodeJS.ProcessEnv,
  json: boolean,
): boolean {
  if (json) return false;
  if (env['NO_COLOR'] !== undefined) return false;
  if (env['FORCE_COLOR'] !== undefined) return true;
  return stream.isTTY === true;
}

export function createIo(options: {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  json: boolean;
}): Io {
  const colour = shouldUseColour(options.stdout, options.env, options.json);
  return {
    out: (text) => void options.stdout.write(`${text}\n`),
    err: (text) => void options.stderr.write(`${text}\n`),
    colour,
  };
}

/** Machine output: one JSON document, on stdout, and nothing else. */
export function emitJson(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

export interface Column {
  header: string;
  /** Numbers read right-aligned; anything else reads left-aligned. */
  align?: 'left' | 'right';
}

/**
 * A fixed-width table.
 *
 * Width is measured in code units, which is wrong for wide glyphs and combining
 * marks and right for everything this renders — model ids, uuids, instance
 * paths, counts. Each of those is ASCII by its own schema rule, so a
 * grapheme-aware measurer would be machinery guarding a case the protocol
 * cannot deliver.
 */
export function renderTable(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const widths = columns.map((column, index) =>
    rows.reduce((widest, row) => Math.max(widest, (row[index] ?? '').length), column.header.length),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        return columns[index]?.align === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return [
    line(columns.map((column) => column.header)),
    line(widths.map((width) => '─'.repeat(width))),
    ...rows.map(line),
  ].join('\n');
}

/** Cut a value down to one readable line, marking that it was cut. */
export function truncate(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, Math.max(0, limit - 1))}…`;
}
