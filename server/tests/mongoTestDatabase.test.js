import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

test('MongoDB test URI selects a unique dedicated database regardless of its original path', () => {
  const first = createIsolatedMongoTestDatabase('mongodb://user:pass@localhost:27017/production', 'auth');
  const second = createIsolatedMongoTestDatabase('mongodb://localhost:27017/production', 'auth');
  expect(first.databaseName).toMatch(/^astradj_test_auth_[a-f0-9]{32}$/);
  expect(new URL(first.uri).pathname).toBe(`/${first.databaseName}`);
  expect(second.databaseName).not.toBe(first.databaseName);
});

test('MongoDB test isolation rejects malformed URIs and unsafe cleanup targets', async () => {
  expect(() => createIsolatedMongoTestDatabase('https://localhost/db', 'auth')).toThrow('MongoDB connection URI');
  const calls = [];
  const mongoose = {
    connection: { name: 'production', dropDatabase: async () => calls.push('drop') },
    disconnect: async () => calls.push('disconnect'),
  };
  await expect(dropIsolatedMongoTestDatabase(mongoose, 'production')).rejects.toThrow('Refusing to drop');
  expect(calls).toEqual(['disconnect']);
});
