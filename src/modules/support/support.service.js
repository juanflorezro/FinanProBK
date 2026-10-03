import { env } from '../../config/env.js';
import { httpError } from '../../utils/errors.js';
import { sendMail } from '../../services/notifications/mailer.js';
import { supportAdminEmail, supportUserEmail } from '../../services/notifications/templates.js';
import { Ticket } from './ticket.model.js';
import { TicketMessage } from './ticketMessage.model.js';
import { PlatformAdmin } from '../platform/platformAdmin.model.js';
import { Organization } from '../organizations/organization.model.js';
import { User } from '../auth/user.model.js';
import { Counter } from '../counters/counter.model.js';

const EMAIL_EVERY_MS = 10 * 60_000; // máximo un correo cada 10 min por solicitud y por lado

export const TYPE_LABEL = {
  chat: 'Chat con soporte', falla: 'Reportar una falla', eliminar_credito: 'Eliminar un crédito',
  ajuste_pago: 'Corregir un pago', consulta: 'Consulta', otro: 'Otro',
};

async function nextTicketNumber() {
  // Consecutivo global de la plataforma (no por organización)
  const doc = await Counter.collection.findOneAndUpdate(
    { _id: 'platform:ticket' },
    { $inc: { seq: 1 }, $setOnInsert: { key: 'ticket' } },
    { upsert: true, returnDocument: 'after' },
  );
  return (doc?.value ?? doc).seq;
}

/** Correo a los admins: al asignado; si no hay, a superadmins y soporte. */
async function notifyAdmins(ticket, { event, preview, force = false }) {
  if (!force && ticket.lastAdminEmailAt && Date.now() - ticket.lastAdminEmailAt < EMAIL_EVERY_MS) return;
  const filter = ticket.assignedAdminId
    ? { _id: ticket.assignedAdminId, status: 'activo' }
    : { role: { $in: ['superadmin', 'soporte'] }, status: 'activo' };
  const admins = await PlatformAdmin.find(filter).select('email name');
  if (!admins.length) return;
  const org = await Organization.findById(ticket.orgId).select('name');
  const url = `${env.APP_URL}/admin/soporte?t=${ticket._id}`;
  await Promise.allSettled(admins.map((a) => sendMail({
    to: a.email,
    ...supportAdminEmail({ event, orgName: org?.name, ticket: { number: ticket.number, subject: ticket.subject, type: TYPE_LABEL[ticket.type], priority: ticket.priority }, preview, url }),
  })));
  ticket.lastAdminEmailAt = new Date();
}

async function notifyUser(ticket, preview) {
  if (!ticket.openedBy) return;
  if (ticket.lastUserEmailAt && Date.now() - ticket.lastUserEmailAt < EMAIL_EVERY_MS) return;
  const user = await User.findById(ticket.openedBy).select('email');
  if (!user) return;
  await sendMail({
    to: user.email,
    ...supportUserEmail({ ticket: { number: ticket.number, subject: ticket.subject }, preview, url: `${env.APP_URL}/soporte?t=${ticket._id}` }),
  }).catch(() => {});
  ticket.lastUserEmailAt = new Date();
}

const previewOf = (body) => body.replace(/\s+/g, ' ').slice(0, 140);

/**
 * Conversación general de la organización; se crea la primera vez.
 * Si por peticiones simultáneas quedaron chats duplicados, los une en el más antiguo.
 */
export async function getOrCreateChat(org, user) {
  const chats = await Ticket.find({ orgId: org._id, type: 'chat' }).sort({ createdAt: 1 });
  if (chats.length > 1) {
    const [main, ...dupes] = chats;
    const ids = dupes.map((c) => c._id);
    await TicketMessage.updateMany({ ticketId: { $in: ids } }, { $set: { ticketId: main._id } });
    main.unreadForAdmin += dupes.reduce((a, c) => a + c.unreadForAdmin, 0);
    main.unreadForUser += dupes.reduce((a, c) => a + c.unreadForUser, 0);
    const last = chats.reduce((a, c) => (c.lastMessageAt > a.lastMessageAt ? c : a), main);
    main.lastMessageAt = last.lastMessageAt;
    main.lastMessagePreview = last.lastMessagePreview;
    await main.save();
    await Ticket.collection.deleteMany({ _id: { $in: ids } });
    return main;
  }
  if (chats[0]) return chats[0];
  try {
    return await Ticket.create({ number: await nextTicketNumber(), orgId: org._id, openedBy: user?._id, type: 'chat', subject: `Chat de ${org.name}`, status: 'abierto' });
  } catch (err) {
    if (err.code !== 11000) throw err;
    return Ticket.findOne({ orgId: org._id, type: 'chat' }); // otra petición lo creó primero
  }
}

export async function createTicket({ org, user, type, subject, body, relatedLoanId, priority }) {
  if (type === 'chat') throw httpError(400, 'INVALID_TYPE', 'Usa el chat para conversar');
  const ticket = await Ticket.create({
    number: await nextTicketNumber(), orgId: org._id, openedBy: user._id, type, subject, relatedLoanId,
    priority: priority ?? (type === 'falla' ? 'alta' : 'media'),
    lastMessageAt: new Date(), lastMessagePreview: previewOf(body), unreadForAdmin: 1,
  });
  await TicketMessage.create({ ticketId: ticket._id, orgId: org._id, authorType: 'user', authorId: user._id, authorName: user.name ?? user.email, body });
  await notifyAdmins(ticket, { event: 'nueva', preview: previewOf(body), force: true });
  await ticket.save();
  return ticket;
}

export async function addUserMessage(ticket, user, body) {
  if (ticket.status === 'cerrado') throw httpError(409, 'TICKET_CLOSED', 'Esta solicitud está cerrada. Abre una nueva.');
  const msg = await TicketMessage.create({ ticketId: ticket._id, orgId: ticket.orgId, authorType: 'user', authorId: user._id, authorName: user.name ?? user.email, body });
  ticket.lastMessageAt = msg.createdAt;
  ticket.lastMessagePreview = previewOf(body);
  ticket.unreadForAdmin += 1;
  if (['resuelto', 'esperando_cliente'].includes(ticket.status)) ticket.status = 'abierto';
  await notifyAdmins(ticket, { event: 'mensaje', preview: previewOf(body) });
  await ticket.save();
  return msg;
}

export async function addAdminMessage(ticket, admin, body, internal = false) {
  const msg = await TicketMessage.create({ ticketId: ticket._id, orgId: ticket.orgId, authorType: 'admin', authorId: admin._id, authorName: admin.name, body, internal });
  if (!internal) {
    ticket.lastMessageAt = msg.createdAt;
    ticket.lastMessagePreview = previewOf(body);
    ticket.unreadForUser += 1;
    if (ticket.status === 'abierto' && ticket.type !== 'chat') ticket.status = 'en_progreso';
    if (!ticket.assignedAdminId) ticket.assignedAdminId = admin._id;
    await notifyUser(ticket, previewOf(body));
  }
  await ticket.save();
  return msg;
}

export async function addSystemMessage(ticket, body) {
  await TicketMessage.create({ ticketId: ticket._id, orgId: ticket.orgId, authorType: 'system', authorName: 'FinanPro', body });
  ticket.lastMessageAt = new Date();
  ticket.lastMessagePreview = previewOf(body);
  ticket.unreadForUser += 1;
}

export async function assignTicket(ticket, adminId) {
  ticket.assignedAdminId = adminId ?? null;
  if (adminId) await notifyAdmins(ticket, { event: 'asignada', preview: ticket.lastMessagePreview, force: true });
}
