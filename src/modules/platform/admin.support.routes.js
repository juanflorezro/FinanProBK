import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { httpError } from '../../utils/errors.js';
import { objectId, pagination } from '../../utils/schemas.js';
import { audit } from '../audit/audit.service.js';
import { Ticket, TICKET_TYPES, TICKET_STATUS } from '../support/ticket.model.js';
import { TicketMessage } from '../support/ticketMessage.model.js';
import { addAdminMessage, assignTicket, addSystemMessage } from '../support/support.service.js';
import { PlatformAdmin } from './platformAdmin.model.js';
import { Loan } from '../loans/loan.model.js';
import { runWithContext } from '../../db/context.js';

const router = Router();
const OPEN = ['abierto', 'en_progreso', 'esperando_cliente'];

router.get('/summary', async (req, res) => {
  const [open, unassigned, mine, unread] = await Promise.all([
    Ticket.countDocuments({ status: { $in: OPEN }, type: { $ne: 'chat' } }),
    Ticket.countDocuments({ status: { $in: OPEN }, type: { $ne: 'chat' }, assignedAdminId: null }),
    Ticket.countDocuments({ status: { $in: OPEN }, assignedAdminId: req.admin._id }),
    Ticket.aggregate([{ $group: { _id: null, n: { $sum: '$unreadForAdmin' } } }]),
  ]);
  res.json({ open, unassigned, mine, unread: unread[0]?.n ?? 0 });
});

router.get('/tickets', validate({
  query: pagination.extend({
    status: z.enum([...TICKET_STATUS, 'abiertas']).optional(),
    type: z.enum(TICKET_TYPES).optional(),
    assigned: z.enum(['me', 'none']).optional(),
    orgId: objectId.optional(),
  }),
}), async (req, res) => {
  const { page, limit, status, type, assigned, orgId } = req.valid.query;
  const filter = {};
  if (status === 'abiertas') filter.status = { $in: OPEN };
  else if (status) filter.status = status;
  if (type) filter.type = type;
  if (orgId) filter.orgId = orgId;
  if (assigned === 'me') filter.assignedAdminId = req.admin._id;
  if (assigned === 'none') filter.assignedAdminId = null;
  const [items, total] = await Promise.all([
    Ticket.find(filter).sort({ unreadForAdmin: -1, lastMessageAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('orgId', 'name').populate('assignedAdminId', 'name'),
    Ticket.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
});

async function loadTicket(id) {
  const t = await Ticket.findById(id);
  if (!t) throw httpError(404, 'TICKET_NOT_FOUND', 'Solicitud no encontrada');
  return t;
}

router.get('/tickets/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const ticket = await loadTicket(req.valid.params.id);
  if (ticket.unreadForAdmin) await Ticket.updateOne({ _id: ticket._id }, { $set: { unreadForAdmin: 0 } });
  await ticket.populate([
    { path: 'orgId', select: 'name status country' },
    { path: 'openedBy', select: 'name email' },
    { path: 'assignedAdminId', select: 'name email' },
  ]);
  const relatedLoan = ticket.relatedLoanId
    ? await runWithContext({ orgId: ticket.orgId._id }, () => Loan.findById(ticket.relatedLoanId).setOptions({ withDeleted: true }).select('loanNumber status deletedAt deletedReason').exec())
    : null;
  const [messages, admins] = await Promise.all([
    TicketMessage.find({ ticketId: ticket._id }).sort({ createdAt: 1 }).limit(1000),
    PlatformAdmin.find({ status: 'activo' }).select('name role').sort({ name: 1 }),
  ]);
  res.json({ ticket, messages, admins, relatedLoan });
});

router.post('/tickets/:id/messages', validate({
  params: z.object({ id: objectId }),
  body: z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) }),
}), async (req, res) => {
  const ticket = await loadTicket(req.valid.params.id);
  res.status(201).json(await addAdminMessage(ticket, req.admin, req.valid.body.body, req.valid.body.internal));
});

router.patch('/tickets/:id', validate({
  params: z.object({ id: objectId }),
  body: z.object({
    status: z.enum(TICKET_STATUS).optional(),
    priority: z.enum(['baja', 'media', 'alta', 'critica']).optional(),
    assignedAdminId: objectId.nullable().optional(),
  }),
}), async (req, res) => {
  const ticket = await loadTicket(req.valid.params.id);
  const { status, priority, assignedAdminId } = req.valid.body;
  const before = { status: ticket.status, priority: ticket.priority, assignedAdminId: ticket.assignedAdminId };
  if (priority) ticket.priority = priority;
  if (status && status !== ticket.status) {
    if (ticket.type === 'chat' && ['resuelto', 'cerrado'].includes(status)) throw httpError(400, 'CHAT_NOT_CLOSABLE', 'El chat general no se cierra');
    ticket.status = status;
    if (['resuelto', 'cerrado'].includes(status)) ticket.resolvedAt = new Date();
    await addSystemMessage(ticket, `${req.admin.name} cambió el estado a "${status.replace('_', ' ')}".`);
  }
  if (assignedAdminId !== undefined && String(assignedAdminId) !== String(ticket.assignedAdminId)) {
    await assignTicket(ticket, assignedAdminId);
  }
  await ticket.save();
  await audit(req, { action: 'support.ticket_update', entity: 'Ticket', entityId: ticket._id, orgId: ticket.orgId, before, after: req.valid.body });
  res.json(ticket);
});

export default router;
