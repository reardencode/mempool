const log: string[] = [];

function fakeConnection(id: string) {
  return {
    query: jest.fn(async (q: any) => { log.push(`${id}: ${q?.sql ?? q}`); return [[], []]; }),
    beginTransaction: jest.fn(async () => { log.push(`${id}: BEGIN`); }),
    commit: jest.fn(async () => { log.push(`${id}: COMMIT`); }),
    rollback: jest.fn(async () => { log.push(`${id}: ROLLBACK`); }),
    release: jest.fn(() => { log.push(`${id}: release`); }),
  };
}

// Like mysql2's pool, plain pool.query() may run on any idle connection.
let next = 0;
const fakePool = {
  on: jest.fn(),
  query: jest.fn(async (q: any) => { log.push(`pool${next++ % 3}: ${q?.sql ?? q}`); return [[], []]; }),
  getConnection: jest.fn(async () => fakeConnection('txn')),
};

jest.mock('mysql2/promise', () => ({ createPool: () => fakePool }));

import DB from '../database';

describe('DB.$transaction', () => {
  beforeEach(() => {
    log.length = 0;
    next = 0;
  });

  test('runs every DB.query inside the callback on one connection, then commits', async () => {
    await DB.$transaction(async () => {
      await DB.query('UPDATE blocks SET pool_id = 1');
      await DB.query({ sql: 'DELETE FROM state', timeout: 1000 });
    });
    await DB.query('SELECT 1');

    expect(log).toEqual([
      'txn: BEGIN',
      'txn: UPDATE blocks SET pool_id = 1',
      'txn: DELETE FROM state',
      'txn: COMMIT',
      'txn: release',
      'pool0: SELECT 1',
    ]);
  });

  test('rolls back and rethrows when the callback fails', async () => {
    await expect(DB.$transaction(async () => {
      await DB.query('UPDATE blocks SET pool_id = 1');
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(log).toEqual([
      'txn: BEGIN',
      'txn: UPDATE blocks SET pool_id = 1',
      'txn: ROLLBACK',
      'txn: release',
    ]);
  });
});
