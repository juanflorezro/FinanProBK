// Crea un administrador de plataforma con 2FA obligatorio.
// Uso: node --env-file=.env scripts/create-admin.js correo@ejemplo.com "Nombre" superadmin
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI } from 'otplib';
import { connectDB, disconnectDB } from '../src/db/connect.js';
import { encrypt } from '../src/utils/crypto.js';
import { PlatformAdmin, ADMIN_ROLES } from '../src/modules/platform/platformAdmin.model.js';

const [email, name, role = 'superadmin'] = process.argv.slice(2);
if (!email || !name || !ADMIN_ROLES.includes(role)) {
  console.error(`Uso: npm run create-admin -- correo@ejemplo.com "Nombre" [${ADMIN_ROLES.join('|')}]`);
  process.exit(1);
}

await connectDB();
if (await PlatformAdmin.exists({ email: email.toLowerCase() })) {
  console.error('Ya existe un administrador con ese correo');
  await disconnectDB();
  process.exit(1);
}

const password = randomBytes(12).toString('base64url');
const secret = generateSecret();
await PlatformAdmin.create({
  email: email.toLowerCase(),
  name,
  role,
  passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
  totpSecret: encrypt(secret),
});

console.log('\nAdministrador creado. Guarda estos datos, no se vuelven a mostrar:\n');
console.log(`  Correo:      ${email.toLowerCase()}`);
console.log(`  Contraseña:  ${password}`);
console.log(`  Rol:         ${role}`);
console.log('\nAgrega la cuenta a Google Authenticator o Microsoft Authenticator:');
console.log(`  Clave manual: ${secret}`);
console.log(`  Enlace:       ${generateURI({ issuer: 'FinanPro Admin', label: email.toLowerCase(), secret })}\n`);
await disconnectDB();
