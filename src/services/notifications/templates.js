const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const layout = (title, body) => `<!doctype html><html><body style="margin:0;background:#f3f6f4;font-family:Arial,Helvetica,sans-serif;color:#102a26">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="100%" style="max-width:480px;background:#fff;border-radius:12px;padding:28px" cellpadding="0" cellspacing="0"><tr><td>
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>${body}
<p style="font-size:12px;color:#56675f;margin-top:28px">Si no esperabas este correo, puedes ignorarlo.</p>
</td></tr></table></td></tr></table></body></html>`;

const PURPOSE = {
  verify_email: { subject: 'Tu código para crear la cuenta', title: 'Confirma tu correo' },
  reset_password: { subject: 'Tu código para cambiar la contraseña', title: 'Cambia tu contraseña' },
  login_2fa: { subject: 'Tu código para iniciar sesión', title: 'Confirma que eres tú' },
};

export function verificationCodeEmail({ code, purpose, minutes }) {
  const p = PURPOSE[purpose];
  return {
    subject: p.subject,
    text: `Tu código es ${code}. Vence en ${minutes} minutos. No lo compartas con nadie.`,
    html: layout(p.title, `<p>Tu código es:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:8px 0 16px">${esc(code)}</p>
<p>Vence en ${minutes} minutos. No lo compartas con nadie.</p>`),
  };
}

const ROLE_LABEL = { admin: 'administrador', analista: 'analista', cobrador: 'cobrador', auditor: 'auditor' };

export function invitationEmail({ orgName, inviterName, role, url, expiresAt }) {
  const roleLabel = ROLE_LABEL[role] ?? role;
  const until = expiresAt.toLocaleDateString('es-CO', { day: 'numeric', month: 'long' });
  return {
    subject: `Te invitaron a ${orgName}`,
    text: `${inviterName} te invitó a ${orgName} como ${roleLabel}. Entra con este correo en ${url} antes del ${until}.`,
    html: layout(`Te invitaron a ${orgName}`, `<p>${esc(inviterName)} te invitó a unirte como <strong>${esc(roleLabel)}</strong>.</p>
<p>Entra con este mismo correo, con Google o creando tu contraseña.</p>
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#2f6b4f;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Entrar a ${esc(orgName)}</a></p>
<p style="font-size:13px;color:#56675f">La invitación vence el ${esc(until)}.</p>`),
  };
}

export function welcomeOwnerEmail({ companyName, url, trialDays }) {
  const trial = trialDays ? ` Tienes ${trialDays} días de prueba.` : '';
  return {
    subject: `Tu cuenta de ${companyName} está lista`,
    text: `Ya puedes crear tu organización en FinanPro.${trial} Entra con este correo en ${url}`,
    html: layout('Tu cuenta está lista', `<p>Habilitamos este correo para que crees la organización de <strong>${esc(companyName)}</strong>.${esc(trial)}</p>
<p>Entra con este mismo correo, con Google o creando tu contraseña.</p>
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#2f6b4f;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Crear mi organización</a></p>`),
  };
}

const SUPPORT_EVENT = {
  nueva: (o) => `Nueva solicitud de ${o}`,
  mensaje: (o) => `Nuevo mensaje de ${o}`,
  asignada: () => 'Te asignaron una solicitud',
};

export function supportAdminEmail({ event, orgName, ticket, preview, url }) {
  const title = SUPPORT_EVENT[event](orgName ?? 'un cliente');
  return {
    subject: `[Soporte #${ticket.number}] ${title}: ${ticket.subject}`,
    text: `${title}\n#${ticket.number} ${ticket.subject} (${ticket.type}, prioridad ${ticket.priority})\n\n"${preview}"\n\nResponder: ${url}`,
    html: layout(title, `<p><strong>#${ticket.number} ${esc(ticket.subject)}</strong><br><span style="color:#56675f">${esc(ticket.type)}, prioridad ${esc(ticket.priority)}</span></p>
<p style="padding:12px 14px;background:#f3f6f4;border-left:3px solid #c9a55a;border-radius:4px">${esc(preview)}</p>
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#2f6b4f;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Abrir en el panel</a></p>`),
  };
}

export function supportUserEmail({ ticket, preview, url }) {
  return {
    subject: `Soporte FinanPro respondió tu solicitud #${ticket.number}`,
    text: `Tienes una respuesta en "${ticket.subject}":\n\n"${preview}"\n\nVer: ${url}`,
    html: layout('Tienes una respuesta de soporte', `<p>Sobre <strong>${esc(ticket.subject)}</strong>:</p>
<p style="padding:12px 14px;background:#f3f6f4;border-left:3px solid #2f6b4f;border-radius:4px">${esc(preview)}</p>
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#2f6b4f;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Ver la conversación</a></p>`),
  };
}
