import mongoose from '../server/node_modules/mongoose/index.js';
import bcrypt from '../server/node_modules/bcryptjs/index.js';
import { User } from '../server/src/models/User.js';

let target;
try { target = new URL(process.env.MONGODB_URI); } catch { target = null; }
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.pathname.startsWith('/astradj_e2e_')) {
  throw new Error('Refusing to create an E2E Admin outside the generated local E2E database');
}
if (!process.env.ASTRADJ_E2E_ADMIN_EMAIL || !process.env.ASTRADJ_E2E_ADMIN_PASSWORD) {
  throw new Error('Missing generated E2E Admin credentials');
}

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
try {
  await User.create({
    email: process.env.ASTRADJ_E2E_ADMIN_EMAIL,
    displayName: 'AstraDJ E2E Admin',
    passwordHash: await bcrypt.hash(process.env.ASTRADJ_E2E_ADMIN_PASSWORD, 10),
    role: 'Admin',
  });
} finally {
  await mongoose.disconnect();
}
