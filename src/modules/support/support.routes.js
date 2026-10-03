import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { httpError } from '../../utils/errors.js';
import { objectId } from '../../utils/schemas.js';
import { Ticket, TICKET_TYPES } from './ticket.model.js';
import { TicketMessage } from './ticketMessage.model.js';
import { getOrCreateChat, createTicket, addUserMessage } from './support.service.js';

// Mesa de ayuda desde la app de la empresa. Funciona aunque la org esté en solo lectura.
const router = Router();
const body = z.string().trim().min(1, 'Escribe un mensaje').max(5000);

async function loadTicket(req, id) {
  const t = await Ticket.findOne({ _id: id, orgId: req.org._id });
  if (!t) throw httpError(404, 'TICKET_NOT_FOUND', 'Solicitud no encontrada');
  return t;
}

const messagesFor = (ticketId) => TicketMessage.find({ ticketId, internal: false }).sort({ createdAt: 1 }).limit(500);

router.get('/unread', async (req, res) => {
  const rows = await Ticket.aggregate([{ $match: { orgId: req.org._id } }, { $group: { _id: null, n: { $sum: '$unreadForUser' } } }]);
  res.json({ unread: rows[0]?.n ?? 0 });
});

router.get('/tickets', async (req, res) => {
  const tickets = await Ticket.find({ orgId: req.org._id, type: { $ne: 'chat' } }).sort({ lastMessageAt: -1 }).limit(100)
    .populate('relatedLoanId', 'loanNumber');
  const chat = await Ticket.findOne({ orgId: req.org._id, type: 'chat' }).select('unreadForUser lastMessageAt lastMessagePreview');
  res.json({ tickets, chat });
});

router.post('/tickets', validate({
  body: z.object({
    type: z.enum(TICKET_TYPES.filter((t) => t !== 'chat')),
    subject: z.string().trim().min(4, 'Escribe un asunto de al menos 4 caracteres').max(140),
    body,
    relatedLoanId: objectId.optional(),
  }),
}), async (req, res) => {
  res.status(201).json(await createTicket({ org: req.org, user: req.user, ...req.valid.body }));
});

/** Conversación general con soporte. */
router.get('/chat', async (req, res) => {
  const chat = await getOrCreateChat(req.org, req.user);
  if (chat.unreadForUser) await Ticket.updateOne({ _id: chat._id }, { $set: { unreadForUser: 0 } });
  res.json({ ticket: chat, messages: await messagesFor(chat._id) });
});

router.post('/chat/messages', validate({ body: z.object({ body }) }), async (req, res) => {
  const chat = await getOrCreateChat(req.org, req.user);
  res.status(201).json(await addUserMessage(chat, req.user, req.valid.body.body));
});

router.get('/tickets/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const ticket = await loadTicket(req, req.valid.params.id);
  if (ticket.unreadForUser) await Ticket.updateOne({ _id: ticket._id }, { $set: { unreadForUser: 0 } });
  await ticket.populate('relatedLoanId', 'loanNumber');
  res.json({ ticket, messages: await messagesFor(ticket._id) });
});

router.post('/tickets/:id/messages', validate({ params: z.object({ id: objectId }), body: z.object({ body }) }), async (req, res) => {
  const ticket = await loadTicket(req, req.valid.params.id);
  res.status(201).json(await addUserMessage(ticket, req.user, req.valid.body.body));
});

router.post('/tickets/:id/close', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const ticket = await loadTicket(req, req.valid.params.id);
  if (ticket.type === 'chat') throw httpError(400, 'CHAT_NOT_CLOSABLE', 'El chat no se cierra');
  ticket.status = 'cerrado';
  ticket.resolvedAt ??= new Date();
  await ticket.save();
  res.json(ticket);
});

export default router;
