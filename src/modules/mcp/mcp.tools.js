import * as z from 'zod';
import { randomUUID } from 'node:crypto';

/*
 * Herramientas MCP de FinanPro: todo lo que una persona puede hacer en la app de su empresa.
 * Cada herramienta llama a la API REST interna como el usuario conectado (mismos permisos por rol,
 * validaciones, reglas y bitácora). Los montos se reciben y se devuelven en pesos.
 */

// ---------------------------------------------------------------- utilidades
const pesos = (c) => (c == null ? null : Math.round(c) / 100);
const cents = (p) => Math.round(Number(String(p).replace(/[^\d.,-]/g, '').replace(',', '.')) * 100);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const fullName = (b) => (b ? `${b.firstName ?? ''} ${b.lastName ?? ''}`.trim() : null);
const isId = (s) => /^[a-f0-9]{24}$/i.test(String(s ?? ''));
const ok = (data, summary) => ({ content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 1)}` }], structuredContent: data });

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const LOAN_STATUS = ['solicitud', 'aprobado', 'desembolsado', 'al_dia', 'en_mora', 'reestructurado', 'pagado', 'castigado', 'anulado'];
const AMORT = ['frances', 'aleman', 'interes_simple', 'solo_interes', 'abonos_libres'];
const AMORT_TXT = 'frances = cuota fija; aleman = capital fijo; interes_simple = interés siempre sobre el capital inicial; solo_interes = paga intereses y el capital al final; abonos_libres = paga interés cada período y abona capital cuando quiera';
const FREQ = ['diaria', 'semanal', 'quincenal', 'mensual'];
const BASIS = ['diaria', 'semanal', 'quincenal', 'mensual', 'anual'];
const METHODS = ['efectivo', 'transferencia', 'nequi', 'daviplata', 'pasarela', 'otro'];
const ROLES = ['admin', 'analista', 'cobrador', 'auditor'];

const loanRow = (l) => ({
  id: l._id, prestamo: l.loanNumber, deudor: fullName(l.borrowerId), documento: l.borrowerId?.docNumber, estado: l.status,
  capital: pesos(l.principal), saldo_capital: pesos(l.balancePrincipal), interes_vencido: pesos(l.balanceInterest), mora: pesos(l.balanceLateInterest),
  dias_atraso: l.daysPastDue, tasa: `${l.rate}% ${l.rateBasis}`, forma_pago: l.amortization, frecuencia: l.frequency, cuotas: l.termCount,
  desembolso: day(l.disbursementDate), proxima_cuota: day(l.nextDueDate), valor_proxima: pesos(l.nextDueAmount),
});
const borrowerRow = (b) => ({
  id: b._id, codigo: b.code, nombre: fullName(b), documento: `${b.docType} ${b.docNumber}`, celular: b.phone, correo: b.email ?? null,
  ciudad: b.city ?? null, calificacion: b.riskRating, estado: b.status,
});
const paymentRow = (p) => ({
  id: p._id, recibo: p.receiptNumber, fecha: day(p.paidAt), valor: pesos(p.amount), medio: p.method, caja: p.cashAccountId?.name ?? null,
  prestamo: p.loanId?.loanNumber ?? null, deudor: fullName(p.borrowerId), estado: p.isReversal ? 'reverso' : p.status,
  a_mora: pesos(p.appliedLateInterest), a_interes: pesos(p.appliedInterest), a_capital: pesos(p.appliedPrincipal), saldo_a_favor: pesos(p.unappliedAmount),
});

export function registerTools(server, { api, ctx }) {
  // ---------------- resolvedores: aceptan id, número o texto
  const known = { loans: new Map(), cash: new Map() };
  async function findLoan(ref) {
    if (isId(ref)) return ref;
    const r = await api('GET', '/loans', { query: { q: ref, limit: 10 } });
    r.items.forEach((l) => known.loans.set(String(l._id), l));
    const exact = r.items.find((l) => l.loanNumber.toLowerCase() === String(ref).toLowerCase());
    if (exact) return exact._id;
    if (r.items.length === 1) return r.items[0]._id;
    if (!r.items.length) throw new Error(`No encontré un préstamo con "${ref}".`);
    throw new Error(`Hay ${r.total} préstamos que coinciden con "${ref}": ${r.items.map((l) => `${l.loanNumber} (${fullName(l.borrowerId)})`).join(', ')}. Indica el número exacto.`);
  }
  async function findBorrower(ref) {
    if (isId(ref)) return ref;
    const r = await api('GET', '/borrowers', { query: { q: ref, limit: 10 } });
    const s = String(ref).toLowerCase();
    const exact = r.items.find((b) => b.docNumber?.toLowerCase() === s || b.code?.toLowerCase() === s);
    if (exact) return exact._id;
    if (r.items.length === 1) return r.items[0]._id;
    if (!r.items.length) throw new Error(`No encontré un deudor con "${ref}".`);
    throw new Error(`Hay ${r.total} deudores que coinciden con "${ref}": ${r.items.map((b) => `${fullName(b)} (${b.docType} ${b.docNumber})`).join(', ')}. Indica el documento.`);
  }
  async function findPayment(ref) {
    if (isId(ref)) return ref;
    const r = await api('GET', '/payments', { query: { q: ref, limit: 10 } });
    const exact = r.items.find((p) => p.receiptNumber === String(ref));
    if (exact) return exact._id;
    if (r.items.length === 1) return r.items[0]._id;
    throw new Error(r.items.length ? `Varios pagos coinciden con "${ref}". Indica el número de recibo exacto.` : `No encontré el pago "${ref}".`);
  }
  async function defaultCash(name) {
    const list = await api('GET', '/cash-accounts');
    list.forEach((c) => known.cash.set(String(c._id), c));
    if (!list.length) throw new Error('La empresa no tiene cajas. Crea una con crear_caja.');
    if (name) {
      const c = list.find((x) => x.name.toLowerCase() === String(name).toLowerCase()) ?? list.find((x) => x.name.toLowerCase().includes(String(name).toLowerCase()));
      if (!c) throw new Error(`No encontré la caja "${name}". Cajas: ${list.map((x) => x.name).join(', ')}.`);
      return c._id;
    }
    if (list.length === 1) return list[0]._id;
    throw new Error(`Indica la caja donde entra el dinero: ${list.map((x) => x.name).join(', ')}.`);
  }

  // ================================================================ CUENTA Y EMPRESA
  server.registerTool('quien_soy', {
    title: 'Mi cuenta en FinanPro',
    description: 'Usuario, empresa y rol con los que ChatGPT está conectado a FinanPro, y qué puede hacer ese rol.',
    inputSchema: z.object({}), annotations: READ,
  }, async () => ok({ usuario: ctx.userName, correo: ctx.userEmail, empresa: ctx.orgName, rol: ctx.role, moneda: ctx.currency, estado_empresa: ctx.orgStatus },
    `Conectado como ${ctx.userName} en ${ctx.orgName} (${ctx.role}).`));

  server.registerTool('ver_configuracion', {
    title: 'Configuración de la empresa',
    description: 'Datos de la empresa, reglas de préstamos (días de gracia, orden de aplicación de pagos, prefijos, tipos permitidos), tope legal de tasa si aplica y plan contratado.',
    inputSchema: z.object({}), annotations: READ,
  }, async () => {
    const s = await api('GET', '/settings');
    const data = {
      empresa: s.organization, reglas: {
        dias_gracia: s.settings?.graceDays, orden_aplicacion_pagos: s.settings?.paymentWaterfall, prefijo_prestamos: s.settings?.loanPrefix,
        prefijo_recibos: s.settings?.receiptPrefix, tipos_permitidos: s.settings?.allowedRegimes, portal_clientes: s.settings?.portalEnabled !== false,
      },
      tope_legal: s.rateCompliance, plan: s.subscription,
    };
    return ok(data, `Configuración de ${s.organization?.name}.`);
  });

  server.registerTool('actualizar_configuracion', {
    title: 'Actualizar configuración',
    description: 'Cambia datos y reglas de la empresa. Solo dueño o admin. Confirma con el usuario antes.',
    inputSchema: z.object({
      nombre: z.string().min(2).max(80).optional(),
      razon_social: z.string().max(120).optional(),
      nit: z.string().max(30).optional(),
      dias_gracia: z.number().int().min(0).max(60).optional(),
      orden_aplicacion_pagos: z.array(z.enum(['mora', 'cargo', 'interes', 'capital'])).length(4).optional().describe('Orden en que se aplica un pago, ej. ["mora","cargo","interes","capital"]'),
      prefijo_prestamos: z.string().max(8).optional(),
      prefijo_recibos: z.string().max(8).optional(),
      tipos_permitidos: z.array(z.enum(['formal', 'informal'])).min(1).optional(),
      portal_clientes: z.boolean().optional(),
    }), annotations: WRITE,
  }, async (a) => {
    const settings = Object.fromEntries(Object.entries({
      graceDays: a.dias_gracia, paymentWaterfall: a.orden_aplicacion_pagos, loanPrefix: a.prefijo_prestamos, receiptPrefix: a.prefijo_recibos,
      allowedRegimes: a.tipos_permitidos, portalEnabled: a.portal_clientes,
    }).filter(([, v]) => v !== undefined));
    await api('PATCH', '/settings', { body: { ...(a.nombre && { name: a.nombre }), ...(a.razon_social && { legalName: a.razon_social }), ...(a.nit && { taxId: a.nit }), ...(Object.keys(settings).length && { settings }) } });
    return ok({ actualizado: true }, 'Configuración actualizada.');
  });

  // ================================================================ TABLERO
  server.registerTool('resumen_cartera', {
    title: 'Resumen de la cartera',
    description: 'Estado general: capital por cobrar, mora, cobrado y prestado en el mes, antigüedad de la mora, préstamos más atrasados, cuotas que vencen en 7 días y últimos pagos.',
    inputSchema: z.object({}), annotations: READ,
  }, async () => {
    const d = await api('GET', '/dashboard');
    const p = d.portfolio;
    const data = {
      cartera: {
        prestamos_activos: p.activeLoans, capital_por_cobrar: pesos(p.balancePrincipal), interes_vencido: pesos(p.interestDue), mora_causada: pesos(p.lateInterestDue),
        prestamos_en_mora: p.overdueLoans, capital_en_mora: pesos(p.overdueBalance), deudores_activos: p.activeBorrowers, pendientes_de_desembolso: p.pendingDisbursement,
      },
      este_mes: { cobrado: pesos(d.month.collected), cobrado_capital: pesos(d.month.collectedPrincipal), cobrado_intereses: pesos(d.month.collectedInterest), pagos: d.month.payments, prestado: pesos(d.month.disbursed), prestamos_desembolsados: d.month.disbursedLoans },
      antiguedad_mora: Object.fromEntries(Object.entries(d.aging ?? {}).map(([k, v]) => [k, { prestamos: v.count, saldo: pesos(v.balance) }])),
      mas_atrasados: (d.overdue ?? []).map((l) => ({ prestamo: l.loanNumber, deudor: fullName(l.borrowerId), celular: l.borrowerId?.phone, dias_atraso: l.daysPastDue, saldo_capital: pesos(l.balancePrincipal) })),
      vencen_7_dias: (d.upcoming ?? []).map((i) => ({ prestamo: i.loanId?.loanNumber, deudor: fullName(i.loanId?.borrowerId), cuota: i.number, vence: day(i.dueDate), valor: pesos(i.principalDue + i.interestDue + (i.feesDue ?? 0) - (i.principalPaid ?? 0) - (i.interestPaid ?? 0) - (i.feesPaid ?? 0)) })),
      ultimos_pagos: (d.recentPayments ?? []).map((x) => ({ recibo: x.receiptNumber, fecha: day(x.paidAt), valor: pesos(x.amount), deudor: fullName(x.borrowerId), prestamo: x.loanId?.loanNumber })),
    };
    return ok(data, `Cartera de ${ctx.orgName}: ${p.activeLoans} préstamos activos, capital por cobrar ${pesos(p.balancePrincipal)}, ${p.overdueLoans} en mora.`);
  });

  // ================================================================ DEUDORES
  server.registerTool('buscar_deudores', {
    title: 'Buscar deudores',
    description: 'Lista o busca deudores por nombre, documento, código o celular, con filtros de estado, calificación y ciudad.',
    inputSchema: z.object({
      texto: z.string().max(60).optional(), estado: z.enum(['activo', 'inactivo', 'bloqueado']).optional(),
      calificacion: z.enum(['A', 'B', 'C', 'D']).optional(), ciudad: z.string().max(60).optional(),
      orden: z.enum(['nombre', 'recientes', 'antiguos']).optional(), pagina: z.number().int().min(1).optional(),
    }), annotations: READ,
  }, async (a) => {
    const r = await api('GET', '/borrowers', { query: { q: a.texto, status: a.estado, riskRating: a.calificacion, city: a.ciudad, sort: a.orden, page: a.pagina ?? 1, limit: 25 } });
    return ok({ total: r.total, pagina: r.page, deudores: r.items.map(borrowerRow) }, `${r.total} deudores encontrados.`);
  });

  server.registerTool('ver_deudor', {
    title: 'Ficha del deudor',
    description: 'Ficha completa de un deudor con todos sus préstamos. Acepta documento, código (C0001), nombre o id.',
    inputSchema: z.object({ deudor: z.string().describe('Documento, código, nombre o id') }), annotations: READ,
  }, async ({ deudor }) => {
    const id = await findBorrower(deudor);
    const r = await api('GET', `/borrowers/${id}`);
    const b = r.borrower ?? r;
    const data = { ...borrowerRow(b), direccion: b.address ?? null, barrio: b.neighborhood ?? null, ocupacion: b.occupation ?? null, ingresos: pesos(b.monthlyIncome), prestamos: (r.loans ?? []).map((l) => loanRow({ ...l, borrowerId: b })) };
    return ok(data, `${fullName(b)}: ${data.prestamos.length} préstamos.`);
  });

  server.registerTool('registrar_deudor', {
    title: 'Registrar deudor',
    description: 'Registra un nuevo deudor. Confirma los datos con el usuario antes. Con el correo podrá entrar al portal de deudores.',
    inputSchema: z.object({
      tipo_documento: z.enum(['CC', 'CE', 'PPT', 'PAS', 'NIT']).describe('CC = cédula de ciudadanía'),
      numero_documento: z.string().regex(/^[0-9A-Za-z-]{4,20}$/).describe('Sin puntos ni espacios'),
      nombres: z.string().min(1).max(60), apellidos: z.string().min(1).max(60), celular: z.string().min(7).max(20),
      otro_telefono: z.string().max(20).optional(), correo: z.string().email().optional(), direccion: z.string().max(200).optional(),
      barrio: z.string().max(80).optional(), ciudad: z.string().max(80).optional(), ocupacion: z.string().max(80).optional(),
      ingresos_mensuales: z.number().min(0).optional().describe('En pesos'), calificacion: z.enum(['A', 'B', 'C', 'D']).optional(),
    }), annotations: WRITE,
  }, async (a) => {
    const b = await api('POST', '/borrowers', {
      body: Object.fromEntries(Object.entries({
        docType: a.tipo_documento, docNumber: a.numero_documento, firstName: a.nombres, lastName: a.apellidos, phone: a.celular.replace(/\D/g, ''),
        phoneAlt: a.otro_telefono?.replace(/\D/g, ''), email: a.correo, address: a.direccion, neighborhood: a.barrio, city: a.ciudad, occupation: a.ocupacion,
        monthlyIncome: a.ingresos_mensuales != null ? cents(a.ingresos_mensuales) : undefined, riskRating: a.calificacion,
      }).filter(([, v]) => v !== undefined && v !== '')),
    });
    return ok(borrowerRow(b), `Deudor ${fullName(b)} registrado con código ${b.code}.`);
  });

  server.registerTool('actualizar_deudor', {
    title: 'Actualizar deudor',
    description: 'Corrige o completa datos de un deudor (el documento no se puede cambiar). Confirma con el usuario antes.',
    inputSchema: z.object({
      deudor: z.string().describe('Documento, código, nombre o id'),
      nombres: z.string().min(1).max(60).optional(), apellidos: z.string().min(1).max(60).optional(), celular: z.string().min(7).max(20).optional(),
      otro_telefono: z.string().max(20).optional(), correo: z.string().email().optional(), direccion: z.string().max(200).optional(),
      barrio: z.string().max(80).optional(), ciudad: z.string().max(80).optional(), ocupacion: z.string().max(80).optional(),
      ingresos_mensuales: z.number().min(0).optional(), calificacion: z.enum(['A', 'B', 'C', 'D']).optional(), estado: z.enum(['activo', 'inactivo', 'bloqueado']).optional(),
    }), annotations: WRITE,
  }, async ({ deudor, ...a }) => {
    const id = await findBorrower(deudor);
    const b = await api('PATCH', `/borrowers/${id}`, {
      body: Object.fromEntries(Object.entries({
        firstName: a.nombres, lastName: a.apellidos, phone: a.celular?.replace(/\D/g, ''), phoneAlt: a.otro_telefono?.replace(/\D/g, ''), email: a.correo,
        address: a.direccion, neighborhood: a.barrio, city: a.ciudad, occupation: a.ocupacion,
        monthlyIncome: a.ingresos_mensuales != null ? cents(a.ingresos_mensuales) : undefined, riskRating: a.calificacion, status: a.estado,
      }).filter(([, v]) => v !== undefined)),
    });
    return ok(borrowerRow(b), `Datos de ${fullName(b)} actualizados.`);
  });

  // ================================================================ PRÉSTAMOS
  server.registerTool('buscar_prestamos', {
    title: 'Buscar préstamos',
    description: 'Busca préstamos por número, nombre, documento o celular del deudor, con filtros de estado, atraso, tipo, forma de pago, montos y fechas.',
    inputSchema: z.object({
      texto: z.string().max(60).optional().describe('Número (P000021), nombre, documento o celular'),
      estado: z.enum(LOAN_STATUS).optional(), solo_con_atraso: z.boolean().optional(), atraso_minimo_dias: z.number().int().min(0).optional(),
      tipo: z.enum(['formal', 'informal']).optional(), forma_pago: z.enum(AMORT).optional(), frecuencia: z.enum(FREQ).optional(),
      capital_desde: z.number().optional(), capital_hasta: z.number().optional(),
      desembolso_desde: z.string().optional().describe('AAAA-MM-DD'), desembolso_hasta: z.string().optional(),
      proxima_cuota_desde: z.string().optional(), proxima_cuota_hasta: z.string().optional(),
      orden: z.enum(['recientes', 'antiguos', 'mora', 'saldo', 'proxima']).optional(), pagina: z.number().int().min(1).optional(),
    }), annotations: READ,
  }, async (a) => {
    const r = await api('GET', '/loans', {
      query: {
        q: a.texto, status: a.estado, overdue: a.solo_con_atraso ? 'true' : undefined, minDpd: a.atraso_minimo_dias, lendingRegime: a.tipo,
        amortization: a.forma_pago, frequency: a.frecuencia, minPrincipal: a.capital_desde != null ? cents(a.capital_desde) : undefined,
        maxPrincipal: a.capital_hasta != null ? cents(a.capital_hasta) : undefined, from: a.desembolso_desde, to: a.desembolso_hasta,
        dueFrom: a.proxima_cuota_desde, dueTo: a.proxima_cuota_hasta, sort: a.orden, page: a.pagina ?? 1, limit: 25,
      },
    });
    return ok({ total: r.total, pagina: r.page, prestamos: r.items.map(loanRow) }, `${r.total} préstamos encontrados${r.total > 25 ? ' (25 por página)' : ''}.`);
  });

  server.registerTool('ver_prestamo', {
    title: 'Detalle del préstamo',
    description: 'Detalle de un préstamo: condiciones, saldos, plan de cuotas con lo pagado y lo pendiente, y pagos recibidos.',
    inputSchema: z.object({ prestamo: z.string().describe('Número (P000021) o id') }), annotations: READ,
  }, async ({ prestamo }) => {
    const id = await findLoan(prestamo);
    const r = await api('GET', `/loans/${id}`);
    const l = r.loan;
    const data = {
      ...loanRow(l), tasa_efectiva_anual: l.rateAnnual ? `${Number(l.rateAnnual).toFixed(2)}%` : null, mora: `${l.lateRate}% ${l.lateRateBasis}`, dias_gracia: l.graceDays,
      total_pagado: pesos(l.totalPaid), vence: day(l.maturityDate), notas: l.notes ?? null,
      cuotas: r.installments.map((i) => ({
        n: i.number, vence: day(i.dueDate), capital: pesos(i.principalDue), interes: pesos(i.interestDue), mora: pesos(i.lateInterestAccrued),
        pagado: pesos(i.principalPaid + i.interestPaid + i.feesPaid + i.lateInterestPaid), condonado: pesos(i.waived), estado: i.status,
      })),
      pagos: r.payments.map((p) => paymentRow({ ...p, loanId: l, borrowerId: l.borrowerId })),
    };
    return ok(data, `Préstamo ${l.loanNumber} de ${fullName(l.borrowerId)}: saldo ${pesos(l.balancePrincipal)}, estado ${l.status}.`);
  });

  const loanTerms = {
    monto: z.number().positive().describe('Capital en pesos'),
    tasa: z.number().min(0).max(1000).describe('Porcentaje, ej. 3 para 3%'),
    periodicidad_tasa: z.enum(BASIS).default('mensual').describe('La tasa es mensual, anual, etc.'),
    tipo_tasa: z.enum(['efectiva', 'nominal']).default('efectiva'),
    forma_pago: z.enum(AMORT).default('frances').describe(AMORT_TXT),
    frecuencia: z.enum(FREQ).default('mensual').describe('Cada cuánto se paga'),
    cuotas: z.number().int().min(1).max(600).optional().describe('Obligatorio salvo en abonos_libres'),
    interes_sobre: z.enum(['saldo_capital', 'capital_inicial']).default('saldo_capital'),
  };
  const termsBody = (a) => ({
    principal: cents(a.monto), rate: String(a.tasa), rateBasis: a.periodicidad_tasa, rateKind: a.tipo_tasa, amortization: a.forma_pago,
    frequency: a.frecuencia, interestBase: a.interes_sobre, ...(a.forma_pago !== 'abonos_libres' && { termCount: a.cuotas }),
  });

  server.registerTool('simular_prestamo', {
    title: 'Simular préstamo',
    description: 'Calcula el plan de cuotas, intereses totales y tasa equivalente sin guardar nada, y revisa el tope legal de tasa si la empresa está acogida a la ley.',
    inputSchema: z.object({ ...loanTerms, primera_cuota: z.string().optional().describe('AAAA-MM-DD') }), annotations: READ,
  }, async (a) => {
    const r = await api('POST', '/loans/simulate', { body: { ...termsBody(a), ...(a.primera_cuota && { firstDueDate: a.primera_cuota }) } });
    const data = {
      tasa_por_cuota: `${Number(r.rates.ratePerPeriod).toFixed(4)}%`, tasa_mensual: `${Number(r.rates.rateMonthly).toFixed(4)}%`, tasa_efectiva_anual: `${Number(r.rates.rateAnnual).toFixed(2)}%`,
      total_capital: pesos(r.totals.principal), total_intereses: pesos(r.totals.interest), total_a_pagar: pesos(r.totals.total),
      tope_legal: r.compliance, cuotas: r.schedule.map((c) => ({ n: c.number, vence: day(c.dueDate), capital: pesos(c.principalDue), interes: pesos(c.interestDue), cuota: pesos(c.principalDue + c.interestDue), saldo: pesos(c.closingBalance) })),
    };
    return ok(data, `Total a pagar ${pesos(r.totals.total)} (intereses ${pesos(r.totals.interest)}).`);
  });

  server.registerTool('crear_prestamo', {
    title: 'Crear préstamo',
    description: 'Crea un préstamo para un deudor y, por defecto, lo desembolsa (genera las cuotas). Antes de llamarla, simula y confirma condiciones con el usuario.',
    inputSchema: z.object({
      deudor: z.string().describe('Documento, código, nombre o id del deudor'),
      ...loanTerms,
      tipo: z.enum(['formal', 'informal']).default('formal'),
      interes_mora: z.number().min(0).max(1000).optional().describe('Porcentaje de mora'),
      periodicidad_mora: z.enum(BASIS).default('mensual'),
      mora_sobre: z.enum(['capital', 'capital_e_interes']).default('capital'),
      dias_gracia: z.number().int().min(0).max(90).optional(),
      notas: z.string().max(1000).optional(),
      desembolsar_ahora: z.boolean().default(true),
      caja_desembolso: z.string().optional().describe('Caja de donde sale el dinero'),
      fecha_desembolso: z.string().optional().describe('AAAA-MM-DD, por defecto hoy'),
      primera_cuota: z.string().optional().describe('AAAA-MM-DD'),
      confirmar_tasa_sobre_tope: z.boolean().optional().describe('Solo si el usuario confirmó crearlo aunque la tasa supere el tope legal'),
    }), annotations: WRITE,
  }, async (a) => {
    const borrowerId = await findBorrower(a.deudor);
    const loan = await api('POST', '/loans', {
      body: {
        borrowerId, ...termsBody(a), lendingRegime: a.tipo, lateRate: String(a.interes_mora ?? 0), lateRateBasis: a.periodicidad_mora, lateInterestBase: a.mora_sobre,
        ...(a.dias_gracia != null && { graceDays: a.dias_gracia }), ...(a.notas && { notes: a.notas }), ...(a.confirmar_tasa_sobre_tope && { acknowledgeRateCap: true }),
      },
    });
    if (!a.desembolsar_ahora) return ok({ id: loan._id, prestamo: loan.loanNumber, estado: loan.status }, `Préstamo ${loan.loanNumber} creado (sin desembolsar).`);
    const cashOut = a.caja_desembolso ? await defaultCash(a.caja_desembolso) : undefined;
    const d = await api('POST', `/loans/${loan._id}/disburse`, { body: { ...(a.fecha_desembolso && { disbursementDate: a.fecha_desembolso }), ...(a.primera_cuota && { firstDueDate: a.primera_cuota }), ...(cashOut && { cashAccountId: cashOut }) } });
    const l = d.loan ?? d;
    return ok({ id: loan._id, prestamo: loan.loanNumber, estado: l.status, proxima_cuota: day(l.nextDueDate), valor_proxima: pesos(l.nextDueAmount), vence: day(l.maturityDate) },
      `Préstamo ${loan.loanNumber} creado y desembolsado.`);
  });

  server.registerTool('desembolsar_prestamo', {
    title: 'Desembolsar préstamo',
    description: 'Desembolsa un préstamo en solicitud o aprobado y genera su plan de cuotas.',
    inputSchema: z.object({ prestamo: z.string(), fecha_desembolso: z.string().optional(), primera_cuota: z.string().optional(), caja: z.string().optional().describe('Caja de donde sale el dinero (queda como egreso)') }), annotations: WRITE,
  }, async (a) => {
    const id = await findLoan(a.prestamo);
    const cashAccountId = a.caja ? await defaultCash(a.caja) : undefined;
    const d = await api('POST', `/loans/${id}/disburse`, { body: { ...(a.fecha_desembolso && { disbursementDate: a.fecha_desembolso }), ...(a.primera_cuota && { firstDueDate: a.primera_cuota }), ...(cashAccountId && { cashAccountId }) } });
    const l = d.loan ?? d;
    return ok({ prestamo: l.loanNumber, estado: l.status, proxima_cuota: day(l.nextDueDate), valor_proxima: pesos(l.nextDueAmount) }, `Préstamo ${l.loanNumber} desembolsado.`);
  });

  server.registerTool('actualizar_mora', {
    title: 'Actualizar saldos y mora',
    description: 'Recalcula al día de hoy la mora, los días de atraso y los saldos de un préstamo.',
    inputSchema: z.object({ prestamo: z.string() }), annotations: { ...WRITE, idempotentHint: true },
  }, async ({ prestamo }) => {
    const id = await findLoan(prestamo);
    const r = await api('POST', `/loans/${id}/refresh`);
    const l = r.loan ?? r;
    return ok(loanRow(l), `Saldos de ${l.loanNumber} actualizados: ${l.daysPastDue ?? 0} días de atraso.`);
  });

  // ================================================================ PAGOS
  server.registerTool('listar_pagos', {
    title: 'Pagos recibidos',
    description: 'Pagos con filtros de fecha, caja, medio, canal, tipo y valor; incluye la suma total. Útil para cierres de caja y reportes.',
    inputSchema: z.object({
      texto: z.string().max(60).optional().describe('Recibo, referencia, deudor o documento'),
      desde: z.string().optional().describe('AAAA-MM-DD'), hasta: z.string().optional(), caja: z.string().optional().describe('Nombre de la caja'),
      medio: z.enum(METHODS).optional(), canal: z.enum(['oficina', 'cobrador', 'portal']).optional(), tipo: z.enum(['aplicados', 'reversados', 'reversos']).optional(),
      valor_desde: z.number().optional(), valor_hasta: z.number().optional(),
      orden: z.enum(['recientes', 'antiguos', 'mayor', 'menor']).optional(), pagina: z.number().int().min(1).optional(),
    }), annotations: READ,
  }, async (a) => {
    const cashId = a.caja ? await defaultCash(a.caja) : undefined;
    const r = await api('GET', '/payments', {
      query: {
        q: a.texto, from: a.desde, to: a.hasta, cashAccountId: cashId, method: a.medio, channel: a.canal, kind: a.tipo,
        minAmount: a.valor_desde != null ? cents(a.valor_desde) : undefined, maxAmount: a.valor_hasta != null ? cents(a.valor_hasta) : undefined,
        sort: a.orden, page: a.pagina ?? 1, limit: 25,
      },
    });
    return ok({ total: r.total, suma: pesos(r.sumAmount), pagina: r.page, pagos: r.items.map(paymentRow) }, `${r.total} pagos, suman ${pesos(r.sumAmount)}.`);
  });

  server.registerTool('registrar_pago', {
    title: 'Registrar pago',
    description: 'Registra un pago a un préstamo. Modalidades (aplicar_a): automatico = lo vencido primero en el orden configurado (mora, cargos, interés, capital); cuotas = solo las cuotas indicadas (opcional: solo ciertos conceptos de esas cuotas, como el interés o la mora de los períodos 1 y 3); intereses = solo mora e intereses, el capital no baja; capital = abono extraordinario a capital (exige estar al día; el deudor elige reducir cuota o plazo, Ley 1555 de 2012); liquidacion = pago total del préstamo (usa cotizar_pago_total para el valor). Confirma valor, préstamo, modalidad y caja con el usuario antes.',
    inputSchema: z.object({
      prestamo: z.string().describe('Número (P000021) o id'),
      valor: z.number().positive().describe('En pesos'),
      aplicar_a: z.enum(['automatico', 'cuotas', 'intereses', 'capital', 'liquidacion']).default('automatico'),
      cuotas: z.array(z.number().int().min(1)).optional().describe('Números de cuota, solo con aplicar_a = cuotas'),
      conceptos: z.array(z.enum(['interes', 'mora', 'cargo', 'capital'])).optional().describe('Con aplicar_a = cuotas: pagar solo esos conceptos de esas cuotas, ej. ["interes"] para abonar intereses del período 1 y 3; se cubre primero la cuota más antigua'),
      efecto_capital: z.enum(['reducir_cuota', 'reducir_plazo']).default('reducir_cuota').describe('Solo con aplicar_a = capital'),
      nota: z.string().max(300).optional(),
      medio: z.enum(METHODS).default('efectivo'),
      caja: z.string().optional().describe('Nombre de la caja; si solo hay una, se usa esa'),
      fecha: z.string().optional().describe('AAAA-MM-DD, por defecto hoy'),
      referencia: z.string().max(80).optional(),
      excedente: z.enum(['proximas_cuotas', 'capital']).optional().describe('Qué hacer si paga de más: adelantar cuotas o abonar a capital'),
    }), annotations: WRITE,
  }, async (a) => {
    const loanId = await findLoan(a.prestamo);
    const cashAccountId = await defaultCash(a.caja);
    const p = await api('POST', '/payments', {
      headers: { 'idempotency-key': randomUUID() },
      body: {
        loanId, amount: cents(a.valor), method: a.medio, cashAccountId, applyTo: a.aplicar_a,
        ...(a.aplicar_a === 'cuotas' && { targetNumbers: a.cuotas ?? [], ...(a.conceptos?.length && { components: a.conceptos }) }), ...(a.aplicar_a === 'capital' && { capitalEffect: a.efecto_capital }),
        ...(a.fecha && { paidAt: a.fecha }), ...(a.referencia && { externalReference: a.referencia }), ...(a.excedente && { excessMode: a.excedente }), ...(a.nota && { notes: a.nota }),
      },
    });
    const pay = p.payment ?? p;
    const loan = (await api('GET', `/loans/${loanId}`)).loan; // estado del préstamo DESPUÉS del pago
    const row = paymentRow({ ...pay, loanId: loan, borrowerId: loan?.borrowerId, cashAccountId: known.cash.get(String(cashAccountId)) });
    return ok({ ...row, prestamo_despues: { saldo_capital: pesos(loan?.balancePrincipal), interes_vencido: pesos(loan?.balanceInterest), mora: pesos(loan?.balanceLateInterest), dias_atraso: loan?.daysPastDue, estado: loan?.status, proxima_cuota: day(loan?.nextDueDate), valor_proxima: pesos(loan?.nextDueAmount) } }, `Pago registrado: recibo ${pay.receiptNumber} por ${pesos(pay.amount)} al préstamo ${loan?.loanNumber} de ${fullName(loan?.borrowerId)}, caja ${row.caja}.`);
  });

  server.registerTool('reversar_pago', {
    title: 'Reversar pago',
    description: 'Anula un pago mal registrado: crea un movimiento en negativo y devuelve las cuotas a como estaban. No se puede deshacer. Pide el motivo y confirma con el usuario.',
    inputSchema: z.object({ recibo: z.string().describe('Número de recibo o id'), motivo: z.string().min(5).max(300) }), annotations: DANGER,
  }, async ({ recibo, motivo }) => {
    const id = await findPayment(recibo);
    const r = await api('POST', `/payments/${id}/reverse`, { body: { reason: motivo } });
    const rev = r.reversal ?? r;
    return ok({ reverso: rev.receiptNumber ?? null, valor: pesos(rev.amount) }, `Pago ${recibo} reversado.`);
  });

  // ================================================================ CAJAS
  server.registerTool('listar_cajas', {
    title: 'Cajas',
    description: 'Cajas registradoras o cuentas donde entra el dinero de los pagos.',
    inputSchema: z.object({ incluir_inactivas: z.boolean().optional() }), annotations: READ,
  }, async ({ incluir_inactivas }) => {
    const list = await api('GET', '/cash-accounts', { query: { todas: incluir_inactivas ? '1' : undefined, saldos: '1' } });
    return ok({ cajas: list.map((c) => ({ id: c._id, nombre: c.name, tipo: c.type, banco: c.bankName ?? null, activa: c.isActive, saldo: pesos(c.balance), ultimo_cierre: day(c.lastClosingDate) })) }, `${list.length} cajas.`);
  });

  server.registerTool('crear_caja', {
    title: 'Crear caja',
    description: 'Crea una caja (efectivo, banco o billetera digital) para recibir pagos.',
    inputSchema: z.object({
      nombre: z.string().min(2).max(60), tipo: z.enum(['efectivo', 'banco', 'billetera_digital']).default('efectivo'),
      banco: z.string().max(60).optional(), ultimos_4_digitos: z.string().regex(/^\d{4}$/).optional(),
      saldo_inicial: z.number().min(0).optional().describe('En pesos'),
    }), annotations: WRITE,
  }, async (a) => {
    const c = await api('POST', '/cash-accounts', { body: { name: a.nombre, type: a.tipo, ...(a.banco && { bankName: a.banco }), ...(a.ultimos_4_digitos && { accountMask: a.ultimos_4_digitos }), ...(a.saldo_inicial && { openingBalance: cents(a.saldo_inicial) }) } });
    return ok({ id: c._id, nombre: c.name, tipo: c.type }, `Caja ${c.name} creada.`);
  });

  server.registerTool('cotizar_pago_total', {
    title: 'Cotizar pago total',
    description: 'Cuánto debe pagar el deudor para cancelar el préstamo en una fecha: capital pendiente, interés vencido, interés del período por días corridos y mora (Ley 1555 de 2012: sin penalidad). No guarda nada.',
    inputSchema: z.object({ prestamo: z.string(), fecha: z.string().optional().describe('AAAA-MM-DD, por defecto hoy') }), annotations: READ,
  }, async ({ prestamo, fecha }) => {
    const id = await findLoan(prestamo);
    const p = await api('GET', `/loans/${id}/payoff`, { query: { date: fecha } });
    return ok({ fecha: day(p.asOf), capital: pesos(p.principal), interes_vencido: pesos(p.overdueInterest), interes_periodo_hasta_hoy: pesos(p.currentInterest), mora: pesos(p.lateInterest), cargos: pesos(p.fees), total: pesos(p.total) },
      `Para cancelar el préstamo hoy: ${pesos(p.total)}.`);
  });

  server.registerTool('ver_caja', {
    title: 'Ver caja',
    description: 'Saldo, resumen del periodo (pagos, ingresos, salidas) y libro de caja con saldo corrido de una caja.',
    inputSchema: z.object({ caja: z.string().describe('Nombre de la caja'), desde: z.string().optional(), hasta: z.string().optional() }), annotations: READ,
  }, async (a) => {
    const id = await defaultCash(a.caja);
    const q = { from: a.desde, to: a.hasta };
    const [s, l] = await Promise.all([api('GET', `/cash-accounts/${id}/summary`, { query: q }), api('GET', `/cash-accounts/${id}/ledger`, { query: { ...q, limit: 60 } })]);
    return ok({
      caja: s.cash.name, saldo_actual: pesos(s.balance), periodo: { saldo_inicial: pesos(s.opening), pagos: pesos(s.payments), cantidad_pagos: s.paymentsCount, otros_ingresos: pesos(s.inflows), salidas: pesos(s.outflows), saldo_final: pesos(s.closing), por_medio: Object.fromEntries(Object.entries(s.byMethod ?? {}).map(([k, v]) => [k, pesos(v)])) },
      ultimo_cierre: day(s.lastClosing?.date), movimientos: l.rows.map((r) => ({ fecha: day(r.date), tipo: r.kind, concepto: r.concept, referencia: r.reference || null, valor: pesos(r.amount), saldo: pesos(r.balance), anulado: r.voided || undefined })),
    }, `${s.cash.name}: saldo ${pesos(s.balance)}.`);
  });

  server.registerTool('editar_caja', {
    title: 'Editar caja',
    description: 'Cambia nombre, tipo, banco, últimos 4 dígitos o notas de una caja, o la activa/desactiva (para desactivar el saldo debe estar en cero). El saldo inicial solo se cambia si la caja no tiene movimientos.',
    inputSchema: z.object({
      caja: z.string(), nombre: z.string().min(2).max(60).optional(), tipo: z.enum(['efectivo', 'banco', 'billetera_digital']).optional(),
      banco: z.string().max(60).optional(), ultimos_4_digitos: z.string().regex(/^\d{4}$/).optional(), notas: z.string().max(300).optional(),
      activa: z.boolean().optional(), saldo_inicial: z.number().min(0).optional(),
    }), annotations: WRITE,
  }, async (a) => {
    const id = await defaultCash(a.caja);
    const c = await api('PATCH', `/cash-accounts/${id}`, { body: Object.fromEntries(Object.entries({ name: a.nombre, type: a.tipo, bankName: a.banco, accountMask: a.ultimos_4_digitos, notes: a.notas, isActive: a.activa, openingBalance: a.saldo_inicial != null ? cents(a.saldo_inicial) : undefined }).filter(([, v]) => v !== undefined)) });
    return ok({ nombre: c.name, tipo: c.type, activa: c.isActive }, `Caja ${c.name} actualizada.`);
  });

  server.registerTool('eliminar_caja', {
    title: 'Eliminar caja',
    description: 'Elimina una caja SOLO si nunca tuvo pagos ni movimientos. Si tiene historial, la API lo impide: ofrece desactivarla con editar_caja.',
    inputSchema: z.object({ caja: z.string() }), annotations: DANGER,
  }, async ({ caja }) => {
    const id = await defaultCash(caja);
    await api('DELETE', `/cash-accounts/${id}`);
    return ok({ eliminada: true }, `Caja ${caja} eliminada.`);
  });

  server.registerTool('movimiento_caja', {
    title: 'Ingreso o egreso de caja',
    description: 'Registra dinero que entra (aporte de capital, otros ingresos) o sale (gastos, arriendo, nómina, retiros) de una caja, con concepto y soporte.',
    inputSchema: z.object({
      caja: z.string(), tipo: z.enum(['ingreso', 'egreso']), valor: z.number().positive(), concepto: z.string().min(3).max(200),
      categoria: z.string().max(60).optional(), referencia: z.string().max(80).optional().describe('Factura o comprobante'), fecha: z.string().optional(),
    }), annotations: WRITE,
  }, async (a) => {
    const id = await defaultCash(a.caja);
    await api('POST', `/cash-accounts/${id}/movements`, { body: { type: a.tipo, amount: cents(a.valor), concept: a.concepto, ...(a.categoria && { category: a.categoria }), ...(a.referencia && { reference: a.referencia }), ...(a.fecha && { date: a.fecha }) } });
    return ok({ caja: a.caja, tipo: a.tipo, valor: a.valor }, `${a.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'} de ${a.valor} registrado en ${a.caja}.`);
  });

  server.registerTool('trasladar_entre_cajas', {
    title: 'Traslado entre cajas',
    description: 'Pasa dinero de una caja a otra (ej. consignar el efectivo del día en el banco). Crea los dos movimientos enlazados.',
    inputSchema: z.object({ desde: z.string(), hacia: z.string(), valor: z.number().positive(), concepto: z.string().max(200).optional(), fecha: z.string().optional() }), annotations: WRITE,
  }, async (a) => {
    const [from, to] = await Promise.all([defaultCash(a.desde), defaultCash(a.hacia)]);
    await api('POST', `/cash-accounts/${from}/transfer`, { body: { toCashAccountId: to, amount: cents(a.valor), ...(a.concepto && { concept: a.concepto }), ...(a.fecha && { date: a.fecha }) } });
    return ok({ desde: a.desde, hacia: a.hacia, valor: a.valor }, `Traslado de ${a.valor} de ${a.desde} a ${a.hacia}.`);
  });

  server.registerTool('cerrar_caja', {
    title: 'Arqueo y cierre de caja',
    description: 'Sin dinero_contado: muestra cuánto debería haber en la caja al cierre del día. Con dinero_contado: cierra la caja (registra sobrante o faltante y bloquea registrar en fechas anteriores). Pide al usuario contar el dinero antes de cerrar.',
    inputSchema: z.object({ caja: z.string(), fecha: z.string().optional(), dinero_contado: z.number().min(0).optional(), observaciones: z.string().max(500).optional() }),
    annotations: DANGER,
  }, async (a) => {
    const id = await defaultCash(a.caja);
    if (a.dinero_contado == null) {
      const p = await api('GET', `/cash-accounts/${id}/closings/preview`, { query: { date: a.fecha } });
      return ok({ fecha: day(p.date), desde_cierre: day(p.lastClosingDate), saldo_inicial: pesos(p.opening), pagos: pesos(p.payments), otros_ingresos: pesos(p.inflows), salidas: pesos(p.outflows), deberia_haber: pesos(p.expected) },
        `En ${a.caja} debería haber ${pesos(p.expected)}. Cuenta el dinero y dime el valor para cerrar.`);
    }
    const k = await api('POST', `/cash-accounts/${id}/closings`, { body: { countedBalance: cents(a.dinero_contado), ...(a.fecha && { date: a.fecha }), ...(a.observaciones && { notes: a.observaciones }) } });
    return ok({ fecha: day(k.date), esperado: pesos(k.expectedBalance), contado: pesos(k.countedBalance), diferencia: pesos(k.difference) },
      k.difference === 0 ? 'Caja cerrada: cuadra exacto.' : `Caja cerrada con ${k.difference > 0 ? 'sobrante' : 'faltante'} de ${pesos(Math.abs(k.difference))}.`);
  });

  // ================================================================ EQUIPO
  server.registerTool('ver_equipo', {
    title: 'Equipo',
    description: 'Miembros de la empresa con su rol y estado, e invitaciones pendientes.',
    inputSchema: z.object({}), annotations: READ,
  }, async () => {
    const r = await api('GET', '/members');
    return ok({
      miembros: r.members.map((m) => ({ id: m.id, nombre: m.user?.name, correo: m.user?.email, rol: m.role, estado: m.status, eres_tu: m.isYou })),
      invitaciones: r.invitations.map((i) => ({ id: i.id, correo: i.email, rol: i.role, vence: day(i.expiresAt), vencida: i.expired })),
    }, `${r.members.length} miembros, ${r.invitations.length} invitaciones pendientes.`);
  });

  server.registerTool('invitar_miembro', {
    title: 'Invitar al equipo',
    description: 'Invita a una persona por correo con un rol. Roles: admin, analista (crea préstamos y pagos), cobrador (registra pagos), auditor (solo consulta).',
    inputSchema: z.object({ correo: z.string().email(), rol: z.enum(ROLES) }), annotations: WRITE,
  }, async ({ correo, rol }) => {
    const r = await api('POST', '/members/invitations', { body: { email: correo, role: rol } });
    return ok({ correo: r.email, rol: r.role, vence: day(r.expiresAt) }, `Invitación enviada a ${correo}.`);
  });

  server.registerTool('cambiar_miembro', {
    title: 'Cambiar rol o estado de un miembro',
    description: 'Cambia el rol de un miembro o lo suspende/reactiva. Confirma con el usuario antes.',
    inputSchema: z.object({ correo: z.string().email().describe('Correo del miembro'), rol: z.enum(ROLES).optional(), estado: z.enum(['activa', 'suspendida']).optional() }),
    annotations: DANGER,
  }, async ({ correo, rol, estado }) => {
    if (!rol && !estado) throw new Error('Indica el nuevo rol o el estado.');
    const r = await api('GET', '/members');
    const m = r.members.find((x) => x.user?.email?.toLowerCase() === correo.toLowerCase());
    if (!m) throw new Error(`${correo} no es miembro de la empresa.`);
    const u = await api('PATCH', `/members/${m.id}`, { body: { ...(rol && { role: rol }), ...(estado && { status: estado }) } });
    return ok({ correo, rol: u.role, estado: u.status }, `${correo}: rol ${u.role}, estado ${u.status}.`);
  });

  server.registerTool('cancelar_invitacion', {
    title: 'Cancelar invitación',
    description: 'Cancela una invitación pendiente.',
    inputSchema: z.object({ correo: z.string().email() }), annotations: DANGER,
  }, async ({ correo }) => {
    const r = await api('GET', '/members');
    const inv = r.invitations.find((i) => i.email.toLowerCase() === correo.toLowerCase());
    if (!inv) throw new Error(`No hay invitación pendiente para ${correo}.`);
    await api('DELETE', `/members/invitations/${inv.id}`);
    return ok({ correo, cancelada: true }, `Invitación a ${correo} cancelada.`);
  });

  // ================================================================ SOPORTE
  server.registerTool('ver_solicitudes_soporte', {
    title: 'Solicitudes a soporte',
    description: 'Solicitudes enviadas al equipo de FinanPro y su estado; con un número de solicitud muestra la conversación.',
    inputSchema: z.object({ numero: z.number().int().optional().describe('Número de la solicitud para ver su conversación') }), annotations: READ,
  }, async ({ numero }) => {
    const r = await api('GET', '/support/tickets');
    if (numero) {
      const t = r.tickets.find((x) => x.number === numero);
      if (!t) throw new Error(`No encontré la solicitud #${numero}.`);
      const d = await api('GET', `/support/tickets/${t._id}`);
      return ok({ numero: t.number, asunto: t.subject, estado: t.status, mensajes: d.messages.map((m) => ({ de: m.authorType === 'user' ? m.authorName : `Soporte (${m.authorName})`, fecha: m.createdAt, texto: m.body })) }, `Solicitud #${numero}: ${t.status}.`);
    }
    return ok({ solicitudes: r.tickets.map((t) => ({ numero: t.number, asunto: t.subject, tipo: t.type, estado: t.status, sin_leer: t.unreadForUser, ultimo_mensaje: t.lastMessagePreview })) }, `${r.tickets.length} solicitudes.`);
  });

  server.registerTool('escribir_a_soporte', {
    title: 'Escribir a soporte',
    description: 'Crea una solicitud al equipo de FinanPro (falla, eliminar un crédito, corregir un pago, consulta) o responde una existente.',
    inputSchema: z.object({
      mensaje: z.string().min(10).max(5000),
      numero_solicitud: z.number().int().optional().describe('Para responder una solicitud existente'),
      tipo: z.enum(['falla', 'eliminar_credito', 'ajuste_pago', 'consulta', 'otro']).optional().describe('Para una solicitud nueva'),
      asunto: z.string().min(4).max(140).optional(),
      prestamo: z.string().optional().describe('Préstamo relacionado'),
    }), annotations: WRITE,
  }, async (a) => {
    if (a.numero_solicitud) {
      const r = await api('GET', '/support/tickets');
      const t = r.tickets.find((x) => x.number === a.numero_solicitud);
      if (!t) throw new Error(`No encontré la solicitud #${a.numero_solicitud}.`);
      await api('POST', `/support/tickets/${t._id}/messages`, { body: { body: a.mensaje } });
      return ok({ numero: t.number, enviado: true }, `Mensaje enviado en la solicitud #${t.number}.`);
    }
    const relatedLoanId = a.prestamo ? await findLoan(a.prestamo) : undefined;
    const t = await api('POST', '/support/tickets', { body: { type: a.tipo ?? 'consulta', subject: a.asunto ?? a.mensaje.slice(0, 60), body: a.mensaje, ...(relatedLoanId && { relatedLoanId }) } });
    return ok({ numero: t.number, estado: t.status }, `Solicitud #${t.number} enviada a soporte.`);
  });
}
