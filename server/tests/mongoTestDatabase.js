import crypto from 'node:crypto';

const isolatedName = /^astradj_test_[a-z][a-z0-9]*_[a-f0-9]{32}$/;

export function createIsolatedMongoTestDatabase(configuredUri, suite) {
  if (typeof configuredUri !== 'string' || !configuredUri.trim()) throw new Error('MONGODB_TEST_URI is required');
  if (!/^[a-z][a-z0-9]*$/.test(suite)) throw new Error('MongoDB test suite name is invalid');
  const mongoUrl = new URL(configuredUri);
  if (!['mongodb:', 'mongodb+srv:'].includes(mongoUrl.protocol) || !mongoUrl.hostname) {
    throw new Error('MONGODB_TEST_URI must be a MongoDB connection URI');
  }
  const databaseName = `astradj_test_${suite}_${crypto.randomUUID().replaceAll('-', '')}`;
  mongoUrl.pathname = `/${databaseName}`;
  return { uri: mongoUrl.toString(), databaseName };
}

export async function dropIsolatedMongoTestDatabase(mongoose, databaseName) {
  try {
    if (!isolatedName.test(databaseName) || mongoose.connection.name !== databaseName) {
      throw new Error('Refusing to drop a MongoDB database outside the AstraDJ test namespace');
    }
    await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
}
