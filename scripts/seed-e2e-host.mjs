import mongoose from '../server/node_modules/mongoose/index.js';
import bcrypt from '../server/node_modules/bcryptjs/index.js';
import { User } from '../server/src/models/User.js';

let target;
try { target = new URL(process.env.MONGODB_URI); } catch { target = null; }
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.pathname.startsWith('/astradj_e2e_')) {
  throw new Error('Refusing to create an E2E Host outside the generated local E2E database');
}
const hosts = [
  { email: process.env.ASTRADJ_E2E_HOST_EMAIL, password: process.env.ASTRADJ_E2E_HOST_PASSWORD, displayName: 'AstraDJ E2E Host' },
  { email: process.env.ASTRADJ_E2E_NATURAL_HOST_EMAIL, password: process.env.ASTRADJ_E2E_NATURAL_HOST_PASSWORD, displayName: 'AstraDJ Natural Segue Host' },
];
if (hosts.some(({ email, password }) => !email || !password)) throw new Error('Missing generated E2E Host credentials');

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
try {
  for (const { email, password, displayName } of hosts) {
    await User.create({ email, displayName, passwordHash: await bcrypt.hash(password, 10), role: 'Host' });
  }
} finally {
  await mongoose.disconnect();
}
