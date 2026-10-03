// Habilita un correo de dueño para probar sin el panel de administrador.
// Uso: node --env-file=.env scripts/seed-dev.js correo@ejemplo.com "Mi Empresa"
import { connectDB, disconnectDB } from '../src/db/connect.js';
import { TenantAccount } from '../src/modules/platform/tenantAccount.model.js';
import { AllowedEmail } from '../src/modules/auth/allowedEmail.model.js';

const [email, company = 'Empresa de prueba'] = process.argv.slice(2);
if (!email) {
  console.error('Uso: node --env-file=.env scripts/seed-dev.js correo@ejemplo.com "Mi Empresa"');
  process.exit(1);
}

await connectDB();
const account = await TenantAccount.findOneAndUpdate(
  { contactEmail: email.toLowerCase() },
  { $setOnInsert: { legalName: company, contactEmail: email.toLowerCase(), status: 'habilitado', approvedAt: new Date() } },
  { upsert: true, returnDocument: 'after' },
);
await AllowedEmail.findOneAndUpdate(
  { email: email.toLowerCase(), orgId: null },
  { $set: { tenantAccountId: account._id, intendedRole: 'owner', status: 'habilitado', expiresAt: null } },
  { upsert: true, returnDocument: 'after' },
);
console.log(`Correo habilitado como dueño: ${email} (cuenta ${account._id})`);
await disconnectDB();
