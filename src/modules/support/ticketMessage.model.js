import mongoose from 'mongoose';
import { ref, enumOf } from '../../db/types.js';

// Mensajes de la mesa de ayuda. Solo inserción: el historial queda guardado.
const messageSchema = new mongoose.Schema({
  ticketId: ref('Ticket', { required: true }),
  orgId: ref('Organization', { required: true }),
  authorType: enumOf(['user', 'admin', 'system'], { required: true }),
  authorId: { type: 'ObjectId' },
  authorName: String,
  body: { type: String, required: true, maxlength: 5000 },
  internal: { type: Boolean, default: false }, // nota interna: el cliente no la ve
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

messageSchema.index({ ticketId: 1, createdAt: 1 });

export const TicketMessage = mongoose.model('TicketMessage', messageSchema, 'ticket_messages');
