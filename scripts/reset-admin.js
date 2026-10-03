import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI } from 'otplib';
import { connectDB, disconnectDB } from '../src/db/connect.js';
import { encrypt } from '../src/utils/crypto.js';
import { PlatformAdmin } from '../src/modules/platform/platformAdmin.model.js';

const [email] = process.argv.slice(2);
await connectDB();
const admin = await PlatformAdmin.findOne({ email: email?.toLowerCase() });
if (!admin) { console.error('No existe ese administrador'); await disconnectDB(); process.exit(1); }

const password = randomBytes(12).toString('base64url');
const secret = generateSecret();
admin.passwordHash = await argon2.hash(password, { type: argon2.argon2id });
admin.totpSecret = encrypt(secret);
admin.lastTotpStep = undefined;
admin.failedAttempts = 0;
admin.lockedUntil = undefined;
await admin.save();

console.log(`\nContraseña nueva: ${password}`);
console.log(`Clave para la app: ${secret}`);
console.log(`Enlace: ${generateURI({ issuer: 'FinanPro Admin', label: admin.email, secret })}\n`);
await disconnectDB();