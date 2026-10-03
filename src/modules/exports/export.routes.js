import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import dayjs from 'dayjs';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { httpError } from '../../utils/errors.js';
import { objectId } from '../../utils/schemas.js';
import { Borrower } from '../borrowers/borrower.model.js';
import { Loan } from '../loans/loan.model.js';
import { Payment } from '../payments/payment.model.js';
import { getInstallments } from '../loans/loan.service.js';
import { borrowerQuery, buildBorrowerFilter, loanQuery, buildLoanFilter, paymentQuery, buildPaymentFilter } from '../../utils/listFilters.js';

// Exportaciones a Excel. Funcionan aunque la organización esté en solo lectura.
const router = Router();
router.use(can('export.create'));

const MAX_ROWS = 50_000;
const pesos = (c) => (c == null ? null : c / 100);
const fecha = (d) => (d ? new Date(d) : null);
const MONEY = '"$"#,##0;[Red]-"$"#,##0';
const STATUS = { solicitud: 'Solicitud', aprobado: 'Aprobado', desembolsado: 'Desembolsado', al_dia: 'Al día', en_mora: 'En mora', reestructurado: 'Reestructurado', pagado: 'Pagado', castigado: 'Castigado', anulado: 'Anulado' };
const AMORT = { frances: 'Cuota fija', aleman: 'Capital fijo', interes_simple: 'Interés simple', solo_interes: 'Solo interés', abonos_libres: 'Abonos libres' };

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16, style: c.money ? { numFmt: MONEY } : c.date ? { numFmt: 'dd/mm/yyyy' } : {} }));
  ws.addRows(rows);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF163A32' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

async function send(res, wb, name) {
  const file = `${name}-${dayjs().format('YYYY-MM-DD')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  await wb.xlsx.write(res);
  res.end();
}

const book = (req) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FinanPro';
  wb.company = req.org.name;
  wb.created = new Date();
  return wb;
};

const borrowerRow = (b) => ({
  code: b.code, docType: b.docType, docNumber: b.docNumber, firstName: b.firstName, lastName: b.lastName,
  phone: b.phone, phoneAlt: b.phoneAlt, email: b.email, address: b.address, neighborhood: b.neighborhood, city: b.city,
  occupation: b.occupation, monthlyIncome: pesos(b.monthlyIncome), riskRating: b.riskRating, status: b.status, createdAt: fecha(b.createdAt),
});
const BORROWER_COLS = [
  { header: 'Código', key: 'code', width: 11 }, { header: 'Tipo doc.', key: 'docType', width: 9 }, { header: 'Documento', key: 'docNumber', width: 14 },
  { header: 'Nombres', key: 'firstName', width: 18 }, { header: 'Apellidos', key: 'lastName', width: 18 }, { header: 'Celular', key: 'phone', width: 14 },
  { header: 'Otro teléfono', key: 'phoneAlt', width: 14 }, { header: 'Correo', key: 'email', width: 24 }, { header: 'Dirección', key: 'address', width: 26 },
  { header: 'Barrio', key: 'neighborhood' }, { header: 'Ciudad', key: 'city' }, { header: 'Ocupación', key: 'occupation' },
  { header: 'Ingresos', key: 'monthlyIncome', money: true }, { header: 'Calificación', key: 'riskRating', width: 11 }, { header: 'Estado', key: 'status', width: 11 },
  { header: 'Registrado', key: 'createdAt', date: true, width: 12 },
];

const loanRow = (l) => ({
  loanNumber: l.loanNumber, borrower: l.borrowerId ? `${l.borrowerId.firstName} ${l.borrowerId.lastName}` : '', doc: l.borrowerId?.docNumber,
  phone: l.borrowerId?.phone, regime: l.lendingRegime, principal: pesos(l.principal), rate: Number(l.rate), rateBasis: l.rateBasis,
  rateAnnual: l.rateAnnual ? Number(l.rateAnnual) : null, amortization: AMORT[l.amortization], frequency: l.frequency, termCount: l.termCount,
  disbursementDate: fecha(l.disbursementDate), maturityDate: fecha(l.maturityDate), balancePrincipal: pesos(l.balancePrincipal),
  balanceInterest: pesos(l.balanceInterest), balanceLateInterest: pesos(l.balanceLateInterest), totalPaid: pesos(l.totalPaid),
  daysPastDue: l.daysPastDue, nextDueDate: fecha(l.nextDueDate), nextDueAmount: pesos(l.nextDueAmount), status: STATUS[l.status],
});
const LOAN_COLS = [
  { header: 'Préstamo', key: 'loanNumber', width: 12 }, { header: 'Deudor', key: 'borrower', width: 26 }, { header: 'Documento', key: 'doc', width: 14 },
  { header: 'Celular', key: 'phone', width: 14 }, { header: 'Tipo', key: 'regime', width: 10 }, { header: 'Capital', key: 'principal', money: true },
  { header: 'Tasa %', key: 'rate', width: 9 }, { header: 'Periodicidad', key: 'rateBasis', width: 12 }, { header: 'Tasa EA %', key: 'rateAnnual', width: 11 },
  { header: 'Forma de pago', key: 'amortization', width: 15 }, { header: 'Frecuencia', key: 'frequency', width: 11 }, { header: 'Cuotas', key: 'termCount', width: 8 },
  { header: 'Desembolso', key: 'disbursementDate', date: true, width: 12 }, { header: 'Vence', key: 'maturityDate', date: true, width: 12 },
  { header: 'Saldo capital', key: 'balancePrincipal', money: true }, { header: 'Interés vencido', key: 'balanceInterest', money: true },
  { header: 'Mora', key: 'balanceLateInterest', money: true }, { header: 'Total pagado', key: 'totalPaid', money: true },
  { header: 'Días de atraso', key: 'daysPastDue', width: 10 }, { header: 'Próxima cuota', key: 'nextDueDate', date: true, width: 13 },
  { header: 'Valor próxima', key: 'nextDueAmount', money: true }, { header: 'Estado', key: 'status', width: 13 },
];

const paymentRow = (p) => ({
  receiptNumber: p.receiptNumber, paidAt: fecha(p.paidAt), loan: p.loanId?.loanNumber, borrower: p.borrowerId ? `${p.borrowerId.firstName} ${p.borrowerId.lastName}` : '',
  method: p.method, cash: p.cashAccountId?.name, amount: pesos(p.amount), late: pesos(p.appliedLateInterest), interest: pesos(p.appliedInterest),
  principal: pesos(p.appliedPrincipal), unapplied: pesos(p.unappliedAmount), status: p.isReversal ? 'Reverso' : p.status === 'reversado' ? 'Reversado' : 'Aplicado',
  reference: p.externalReference,
});
const PAYMENT_COLS = [
  { header: 'Recibo', key: 'receiptNumber', width: 11 }, { header: 'Fecha', key: 'paidAt', date: true, width: 12 }, { header: 'Préstamo', key: 'loan', width: 12 },
  { header: 'Deudor', key: 'borrower', width: 26 }, { header: 'Medio', key: 'method', width: 13 }, { header: 'Caja', key: 'cash', width: 16 },
  { header: 'Valor', key: 'amount', money: true }, { header: 'A mora', key: 'late', money: true }, { header: 'A interés', key: 'interest', money: true },
  { header: 'A capital', key: 'principal', money: true }, { header: 'Saldo a favor', key: 'unapplied', money: true }, { header: 'Estado', key: 'status', width: 11 },
  { header: 'Referencia', key: 'reference', width: 18 },
];

// ---------- Exportaciones generales ----------
router.get('/borrowers.xlsx', validate({ query: borrowerQuery }), async (req, res) => {
  const { filter, sort } = await buildBorrowerFilter(req.valid.query);
  const rows = await Borrower.find(filter).sort(sort).limit(MAX_ROWS);
  const wb = book(req);
  sheet(wb, 'Deudores', BORROWER_COLS, rows.map(borrowerRow));
  await send(res, wb, 'deudores');
});

router.get('/loans.xlsx', validate({ query: loanQuery }), async (req, res) => {
  const { filter, sort } = await buildLoanFilter(req.valid.query);
  const rows = await Loan.find(filter).sort(sort).limit(MAX_ROWS).populate('borrowerId', 'firstName lastName docNumber phone');
  const wb = book(req);
  sheet(wb, 'Préstamos', LOAN_COLS, rows.map(loanRow));
  await send(res, wb, 'prestamos');
});

router.get('/payments.xlsx', validate({ query: paymentQuery }), async (req, res) => {
  const { filter, sort } = await buildPaymentFilter(req.valid.query);
  const rows = await Payment.find(filter).sort(sort).limit(MAX_ROWS)
    .populate('loanId', 'loanNumber').populate('borrowerId', 'firstName lastName').populate('cashAccountId', 'name');
  const wb = book(req);
  const ws = sheet(wb, 'Pagos', PAYMENT_COLS, rows.map(paymentRow));
  if (rows.length) {
    const total = ws.addRow({ receiptNumber: 'TOTAL', amount: { formula: `SUM(G2:G${rows.length + 1})` } });
    total.font = { bold: true };
  }
  await send(res, wb, 'pagos');
});

// ---------- Exportaciones individuales ----------
router.get('/loans/:id.xlsx', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const loan = await Loan.findById(req.valid.params.id).populate('borrowerId', 'firstName lastName docType docNumber phone address city');
  if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
  const [installments, payments] = await Promise.all([
    getInstallments(loan),
    Payment.find({ loanId: loan._id }).sort({ paidAt: 1 }).populate('cashAccountId', 'name'),
  ]);
  const wb = book(req);
  const b = loan.borrowerId;
  const resumen = wb.addWorksheet('Estado de cuenta');
  resumen.columns = [{ width: 26 }, { width: 34 }];
  const lines = [
    [req.org.name, ''], ['Estado de cuenta', `Generado el ${dayjs().format('DD/MM/YYYY HH:mm')}`], [],
    ['Préstamo', loan.loanNumber], ['Deudor', `${b.firstName} ${b.lastName}`], ['Documento', `${b.docType} ${b.docNumber}`], ['Celular', b.phone],
    ['Dirección', [b.address, b.city].filter(Boolean).join(', ')], [],
    ['Capital prestado', pesos(loan.principal)], ['Tasa', `${loan.rate} % ${loan.rateBasis} (${Number(loan.rateAnnual).toFixed(2)} % EA)`],
    ['Forma de pago', AMORT[loan.amortization]], ['Desembolso', fecha(loan.disbursementDate)], [],
    ['Saldo de capital', pesos(loan.balancePrincipal)], ['Interés vencido', pesos(loan.balanceInterest)], ['Mora', pesos(loan.balanceLateInterest)],
    ['Total adeudado hoy', pesos(loan.balancePrincipal + loan.balanceInterest + loan.balanceLateInterest + loan.balanceFees)],
    ['Total pagado', pesos(loan.totalPaid)], ['Días de atraso', loan.daysPastDue], ['Estado', STATUS[loan.status]],
  ];
  lines.forEach((l) => resumen.addRow(l));
  resumen.getRow(1).font = { bold: true, size: 14 };
  resumen.getRow(2).font = { bold: true };
  resumen.eachRow((row) => {
    const v = row.getCell(2).value;
    if (typeof v === 'number' && !['Días de atraso'].includes(row.getCell(1).value)) row.getCell(2).numFmt = MONEY;
    if (v instanceof Date) row.getCell(2).numFmt = 'dd/mm/yyyy';
    row.getCell(1).font = { ...row.getCell(1).font, bold: true };
  });
  sheet(wb, 'Cuotas', [
    { header: '#', key: 'n', width: 5 }, { header: 'Vence', key: 'due', date: true, width: 12 }, { header: 'Capital', key: 'p', money: true },
    { header: 'Interés', key: 'i', money: true }, { header: 'Mora', key: 'm', money: true }, { header: 'Pagado', key: 'paid', money: true },
    { header: 'Pendiente', key: 'pend', money: true }, { header: 'Estado', key: 's', width: 11 },
  ], installments.map((i) => ({
    n: i.number, due: fecha(i.dueDate), p: pesos(i.principalDue), i: pesos(i.interestDue), m: pesos(i.lateInterestAccrued),
    paid: pesos(i.principalPaid + i.interestPaid + i.feesPaid + i.lateInterestPaid), pend: pesos(i.pending), s: i.status,
  })));
  sheet(wb, 'Pagos', PAYMENT_COLS, payments.map((p) => paymentRow({ ...p.toObject(), loanId: { loanNumber: loan.loanNumber }, borrowerId: b })));
  await send(res, wb, `estado-de-cuenta-${loan.loanNumber}`);
});

router.get('/borrowers/:id.xlsx', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const borrower = await Borrower.findById(req.valid.params.id);
  if (!borrower) throw httpError(404, 'BORROWER_NOT_FOUND', 'Deudor no encontrado');
  const [loans, payments] = await Promise.all([
    Loan.find({ borrowerId: borrower._id }).sort({ createdAt: -1 }).populate('borrowerId', 'firstName lastName docNumber phone'),
    Payment.find({ borrowerId: borrower._id }).sort({ paidAt: -1 }).populate('loanId', 'loanNumber').populate('cashAccountId', 'name'),
  ]);
  const wb = book(req);
  sheet(wb, 'Deudor', BORROWER_COLS, [borrowerRow(borrower)]);
  sheet(wb, 'Préstamos', LOAN_COLS, loans.map(loanRow));
  sheet(wb, 'Pagos', PAYMENT_COLS, payments.map((p) => paymentRow({ ...p.toObject(), loanId: p.loanId, borrowerId: borrower })));
  await send(res, wb, `deudor-${borrower.docNumber}`);
});

export default router;
