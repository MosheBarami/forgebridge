/**
 * The migration runner, and the rules the migration list has to keep.
 *
 * A migration list is one of the few things in a codebase that cannot be fixed
 * forward: once a version has shipped, files exist in the world that were
 * created by it. So the invariants are asserted here rather than left as a
 * comment in `migrations.ts` — an append-only rule nothing checks is an
 * append-only rule until the first hurried afternoon.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DAEMON_MIGRATIONS,
  STORAGE_MIGRATIONS,
  isUniqueViolation,
  openDatabase,
  type Database,
} from '../src/index.js';

const directories: string[] = [];
const open: Database[] = [];

function scratchFile(name = 'daemon.sqlite'): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'forgebridge-migrations-'));
  directories.push(directory);
  return path.join(directory, name);
}

async function openAt(location: string, migrateTo?: number): Promise<Database> {
  const database = await openDatabase({
    location,
    migrations: DAEMON_MIGRATIONS,
    ...(migrateTo === undefined ? {} : { migrateTo }),
  });
  open.push(database);
  return database;
}

afterEach(() => {
  for (const database of open.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by the test that opened it. Cleanup must not fail a
      // test that has otherwise passed.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the migration list keeps the rules that make it safe to append to', () => {
  it.each([
    ['daemon', DAEMON_MIGRATIONS],
    ['storage', STORAGE_MIGRATIONS],
  ])('%s versions are unique, positive and strictly increasing', (_name, migrations) => {
    const versions = migrations.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.every((version) => Number.isInteger(version) && version > 0)).toBe(true);
    expect(migrations.every((migration) => migration.name.length > 0)).toBe(true);
    expect(migrations.every((migration) => migration.statements.length > 0)).toBe(true);
  });

  it('declares no credential-shaped column', () => {
    // THREAT-MODEL T1's strong form is "there is no column for them; the schema
    // cannot hold one". `scripts/verify-no-key-storage.ts` K1 reads the same
    // file statically; this asserts it against the statements that actually run,
    // which is the half a static reader cannot do for a string it did not parse.
    const sql = [...DAEMON_MIGRATIONS, ...STORAGE_MIGRATIONS]
      .flatMap((migration) => migration.statements)
      .join('\n')
      .toLowerCase();
    for (const forbidden of [
      'api_key',
      'apikey',
      'secret',
      'password',
      'private_key',
      'access_token',
      'auth_token',
      'refresh_token',
      'session_key ',
      'client_secret',
    ]) {
      expect(sql, `a column or table name contains "${forbidden}"`).not.toContain(forbidden);
    }
    // The control: `session_key_id` is an identifier for a key, is stored on
    // `Link` on purpose, and lives inside the JSON document — so the check above
    // must not be so broad that it would have banned it as a column either.
    expect(sql).not.toContain('session_key_id');
  });
});

describe('the runner', () => {
  it('brings a new file all the way up and records what it applied', async () => {
    const database = await openAt(scratchFile());
    expect(database.appliedMigrations()).toEqual(DAEMON_MIGRATIONS.map((migration) => migration.version));
    // The tables are really there, not merely recorded.
    expect(() => database.exec('SELECT 1 FROM links')).not.toThrow();
    expect(() => database.exec('SELECT 1 FROM inbound_nonces')).not.toThrow();
  });

  it('stops where it is told, and finishes the job on the next open', async () => {
    const location = scratchFile();
    const partial = await openAt(location, 0);
    expect(partial.appliedMigrations()).toEqual([]);
    // `schema_migrations` exists even at version zero: the runner needs it to
    // decide anything at all.
    expect(() => partial.exec('SELECT 1 FROM schema_migrations')).not.toThrow();
    expect(() => partial.exec('SELECT 1 FROM links')).toThrow();
    partial.close();

    const full = await openAt(location);
    expect(full.appliedMigrations()).toEqual(DAEMON_MIGRATIONS.map((migration) => migration.version));
  });

  it('is a no-op on a file that is already current', async () => {
    const location = scratchFile();
    const first = await openAt(location);
    first.exec("INSERT INTO project_versions (project_id, version) VALUES ('p', 4)");
    first.close();

    const second = await openAt(location);
    // A runner that re-ran a CREATE TABLE would throw; one that re-ran a data
    // migration would silently duplicate. The row is the evidence that neither
    // happened.
    expect(second.prepare('SELECT version FROM project_versions WHERE project_id = ?').get('p')?.['version']).toBe(
      4,
    );
    expect(second.appliedMigrations()).toEqual(DAEMON_MIGRATIONS.map((migration) => migration.version));
  });

  it('refuses a file written by a newer build instead of guessing at its schema', async () => {
    // Fail closed. A file carrying a migration this build has never seen was
    // written by a newer daemon, and opening it anyway is "I do not understand
    // this" answered as "this is fine" — the exact shape of every bypass this
    // repository has found.
    const location = scratchFile();
    const current = await openAt(location);
    current
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(9999, 'from-the-future', new Date().toISOString());
    current.close();

    await expect(openAt(location)).rejects.toThrow(/newer build/);
  });

  it('leaves the file at the previous version when a migration throws', async () => {
    // Each migration runs in a transaction with the row that records it, so a
    // crash halfway leaves a version that is either fully applied or not
    // applied — never a version whose statements half ran.
    const location = scratchFile();
    const broken = [
      { version: 1, name: 'creates-a-table', statements: ['CREATE TABLE ok (id TEXT PRIMARY KEY)'] },
      {
        version: 2,
        name: 'half-works',
        statements: ['CREATE TABLE half (id TEXT PRIMARY KEY)', 'THIS IS NOT SQL'],
      },
    ];
    await expect(openDatabase({ location, migrations: broken })).rejects.toThrow();

    const reopened = await openDatabase({ location, migrations: [broken[0]!] });
    open.push(reopened);
    expect(reopened.appliedMigrations()).toEqual([1]);
    // The half-created table was rolled back with the failed migration.
    expect(() => reopened.exec('SELECT 1 FROM half')).toThrow();
    expect(() => reopened.exec('SELECT 1 FROM ok')).not.toThrow();
  });

  it('rolls a transaction back and rethrows the original failure', async () => {
    const database = await openAt(':memory:');
    expect(() =>
      database.transaction(() => {
        database.exec("INSERT INTO project_versions (project_id, version) VALUES ('p', 1)");
        throw new Error('the caller changed its mind');
      }),
    ).toThrow('the caller changed its mind');
    expect(database.prepare('SELECT COUNT(*) AS n FROM project_versions').get()?.['n']).toBe(0);
  });
});

describe('isUniqueViolation only claims what it can tell', () => {
  it('recognises a primary key collision', async () => {
    const database = await openAt(':memory:');
    database.prepare('INSERT INTO project_versions (project_id, version) VALUES (?, ?)').run('p', 1);
    try {
      database.prepare('INSERT INTO project_versions (project_id, version) VALUES (?, ?)').run('p', 2);
      expect.unreachable('the second insert should have collided');
    } catch (error) {
      expect(isUniqueViolation(error)).toBe(true);
    }
  });

  it('does not claim a NOT NULL failure is a taken id', async () => {
    // The fail-noisy control. A NOT NULL violation is also SQLITE_CONSTRAINT,
    // and reporting it as "that id already exists" would send whoever reads the
    // message looking for a duplicate that is not there.
    const database = await openAt(':memory:');
    try {
      database.prepare('INSERT INTO project_versions (project_id, version) VALUES (?, ?)').run('p', null);
      expect.unreachable('the insert should have failed on NOT NULL');
    } catch (error) {
      expect(isUniqueViolation(error)).toBe(false);
    }
  });

  it.each([[null], [undefined], ['a string'], [new Error('no errcode')], [{ errcode: 'nineteen' }]])(
    'returns false rather than guessing for %s',
    (value) => {
      expect(isUniqueViolation(value)).toBe(false);
    },
  );
});
