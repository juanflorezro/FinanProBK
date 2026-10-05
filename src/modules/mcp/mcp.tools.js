import * as z from 'zod';
import { computeDashboard } from '../dashboard/dashboard.routes.js';
import { createBorrower, borrowerFields } from '../borrowers/borrower.routes.js';
import { Loan } from '../loans/loan.model.js';
import { loanQuery, buildLoanFilter } from '../../utils/listFilters.js';

// Herramientas MCP de FinanPro. Usan los mismos servicios que la app (permisos por rol,
// validaciones, límites del plan y aislamiento por empresa); `run` aplica rol y contexto.

const pesos = (c) => (c == null ? null : Math.round(c) / 100);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const name = (b) => (b ? `${b.firstName ?? ''} ${b.lastName ?? ''}`.trim() : null);
const ok = (data, summary) => ({
  content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 1)}` }],
  structuredContent: data,
});

const STATUS = ['solicitud', 'aprobado', 'desembolsado', 'al_dia', 'en_mora', 'reestructurado', 'pagado', 'castigado', 'anulado'];

export function registerTools(server, { run, ctx }) {
  server.registerTool('quien_soy', {
    title: 'Mi cuenta en FinanPro',
    description: 'Muestra con qué usuario, empresa y rol está conectado ChatGPT a FinanPro. Úsala si no sabes en qué empresa estás trabajando.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ok({ usuario: ctx.userName, correo: ctx.userEmail, empresa: ctx.orgName, rol: ctx.role, moneda: ctx.currency }, `Conectado como ${ctx.userName} en ${ctx.orgName} (${ctx.role}).`));

  server.registerTool('resumen_cartera', {
    title: 'Resumen de la cartera',
    description: 'Estado general de la cartera de préstamos de la empresa: capital por cobrar, mora, cobrado y prestado en el mes, antigüedad de la mora, préstamos más atrasados y cuotas que vencen en los próximos 7 días. Montos en pesos.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const d = await run('loan.read', () => computeDashboard());
    const p = d.portfolio;
    const data = {
      cartera: {
        prestamos_activos: p.activeLoans, capital_por_cobrar: pesos(p.balancePrincipal), interes_vencido: pesos(p.interestDue),
        mora_causada: pesos(p.lateInterestDue), prestamos_en_mora: p.overdueLoans, capital_en_mora: pesos(p.overdueBalance),
        deudores_activos: p.activeBorrowers, pendientes_de_desembolso: p.pendingDisbursement,
      },
      este_mes: {
        cobrado: pesos(d.month.collected), cobrado_capital: pesos(d.month.collectedPrincipal), cobrado_intereses: pesos(d.month.collectedInterest),
        pagos: d.month.payments, prestado: pesos(d.month.disbursed), prestamos_desembolsados: d.month.disbursedLoans,
      },
      antiguedad_mora: Object.fromEntries(Object.entries(d.aging ?? {}).map(([k, v]) => [k, { prestamos: v.count, saldo: pesos(v.balance) }])),
      mas_atrasados: (d.overdue ?? []).map((l) => ({ prestamo: l.loanNumber, deudor: name(l.borrowerId), celular: l.borrowerId?.phone, dias_atraso: l.daysPastDue, saldo_capital: pesos(l.balancePrincipal) })),
      vencen_7_dias: (d.upcoming ?? []).map((i) => ({
        prestamo: i.loanId?.loanNumber, deudor: name(i.loanId?.borrowerId), cuota: i.number, vence: day(i.dueDate),
        valor: pesos(i.principalDue + i.interestDue + (i.feesDue ?? 0) - (i.principalPaid ?? 0) - (i.interestPaid ?? 0) - (i.feesPaid ?? 0)),
      })),
    };
    return ok(data, `Cartera de ${ctx.orgName}: ${p.activeLoans} préstamos activos, capital por cobrar ${pesos(p.balancePrincipal)}, ${p.overdueLoans} en mora.`);
  });

  server.registerTool('buscar_prestamos', {
    title: 'Buscar préstamos',
    description: 'Busca préstamos de la empresa por número de préstamo, nombre, documento o celular del deudor, y/o por estado. Devuelve saldo, estado, días de atraso y próxima cuota. Montos en pesos.',
    inputSchema: z.object({
      texto: z.string().max(60).optional().describe('Número de préstamo (P000021), nombre, documento o celular del deudor'),
      estado: z.enum(STATUS).optional().describe('Filtrar por estado'),
      solo_con_atraso: z.boolean().optional().describe('Solo préstamos con días de atraso'),
      orden: z.enum(['recientes', 'mora', 'saldo', 'proxima']).optional().describe('recientes, mora (más atraso), saldo (mayor saldo) o proxima (próxima cuota)'),
      pagina: z.number().int().min(1).optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ texto, estado, solo_con_atraso, orden, pagina }) => {
    const page = pagina ?? 1;
    const r = await run('loan.read', async () => {
      const { filter, sort } = await buildLoanFilter(loanQuery.parse({ q: texto, status: estado, overdue: solo_con_atraso ? 'true' : undefined, sort: orden }));
      const [items, total] = await Promise.all([
        Loan.find(filter).sort(sort).skip((page - 1) * 20).limit(20).populate('borrowerId', 'firstName lastName docNumber phone'),
        Loan.countDocuments(filter),
      ]);
      return { items, total, page };
    });
    const data = {
      total: r.total, pagina: r.page,
      prestamos: r.items.map((l) => ({
        id: l._id, prestamo: l.loanNumber, deudor: name(l.borrowerId), documento: l.borrowerId?.docNumber, estado: l.status,
        capital: pesos(l.principal), saldo_capital: pesos(l.balancePrincipal), dias_atraso: l.daysPastDue,
        tasa: `${l.rate}% ${l.rateBasis}`, proxima_cuota: day(l.nextDueDate), valor_proxima: pesos(l.nextDueAmount),
      })),
    };
    return ok(data, `${r.total} préstamos encontrados${r.total > 20 ? ' (mostrando 20; usa pagina para ver más)' : ''}.`);
  });

  server.registerTool('registrar_deudor', {
    title: 'Registrar deudor',
    description: 'Registra un nuevo deudor (cliente) en la empresa. Confirma los datos con el usuario antes de llamarla. Si el documento ya existe, devuelve error.',
    inputSchema: z.object({
      tipo_documento: z.enum(['CC', 'CE', 'PPT', 'PAS', 'NIT']).describe('CC = cédula de ciudadanía'),
      numero_documento: z.string().regex(/^[0-9A-Za-z-]{4,20}$/).describe('Sin puntos ni espacios'),
      nombres: z.string().min(1).max(60),
      apellidos: z.string().min(1).max(60),
      celular: z.string().min(7).max(20),
      correo: z.string().email().optional().describe('Con este correo podrá entrar al portal de deudores'),
      direccion: z.string().max(200).optional(),
      ciudad: z.string().max(80).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (a) => {
    const body = borrowerFields.parse({
      docType: a.tipo_documento, docNumber: a.numero_documento, firstName: a.nombres, lastName: a.apellidos,
      phone: a.celular.replace(/\D/g, ''), ...(a.correo && { email: a.correo }), ...(a.direccion && { address: a.direccion }), ...(a.ciudad && { city: a.ciudad }),
    });
    const b = await run('borrower.create', (org) => createBorrower(org, body), { write: true, action: 'mcp.registrar_deudor' });
    return ok({ id: b._id, codigo: b.code, deudor: name(b), documento: `${b.docType} ${b.docNumber}` }, `Deudor ${name(b)} registrado con código ${b.code}.`);
  });
}
