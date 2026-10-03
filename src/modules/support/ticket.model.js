import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';

export const TICKET_TYPES = ['chat', 'falla', 'eliminar_credito', 'ajuste_pago', 'consulta', 'otro'];
export const TICKET_STATUS = ['abierto', 'en_progreso', 'esperando_cliente', 'resuelto', 'cerrado'];

// Mesa de ayuda. "chat" es la conversación general de cada organización (una sola, nunca se cierra).
const ticketSchema = createSchema({
  number: { type: Number, required: true },
  orgId: ref('Organization', { required: true }),
  openedBy: ref('User'),
  type: enumOf(TICKET_TYPES, { required: true }),
  subject: { type: String, required: true, trim: true, maxlength: 140 },
  status: enumOf(TICKET_STATUS, { default: 'abierto' }),
  priority: enumOf(['baja', 'media', 'alta', 'critica'], { default: 'media' }),
  assignedAdminId: ref('PlatformAdmin'),
  relatedLoanId: ref('Loan'),
  lastMessageAt: { type: Date, default: Date.now },
  lastMessagePreview: String,
  unreadForAdmin: { type: Number, default: 0 },
  unreadForUser: { type: Number, default: 0 },
  lastAdminEmailAt: Date,
  lastUserEmailAt: Date,
  resolvedAt: Date,
}, { tenant: false, optimisticConcurrency: false });

ticketSchema.index({ number: 1 }, { unique: true });
ticketSchema.index({ orgId: 1, type: 1, lastMessageAt: -1 });
ticketSchema.index({ status: 1, assignedAdminId: 1, lastMessageAt: -1 });
// Un solo chat general por organización (evita duplicados si llegan dos peticiones a la vez)
ticketSchema.index({ orgId: 1 }, { unique: true, partialFilterExpression: { type: 'chat' }, name: 'one_chat_per_org' });

export const Ticket = mongoose.model('Ticket', ticketSchema, 'tickets');
