import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, ref, enumOf } from '../../db/types.js';

const cashAccountSchema = createSchema({
  name: { type: String, required: true, trim: true },
  type: enumOf(['efectivo', 'banco', 'billetera_digital'], { default: 'efectivo' }),
  bankName: String,
  accountMask: { type: String, maxlength: 4 },
  currency: { type: String, default: 'COP', uppercase: true },
  custodianMembershipId: ref('Membership'),
  currentBalance: money(),
  isActive: { type: Boolean, default: true },
});

cashAccountSchema.index({ orgId: 1, name: 1 }, { unique: true });

export const CashAccount = mongoose.model('CashAccount', cashAccountSchema, 'cash_accounts');
