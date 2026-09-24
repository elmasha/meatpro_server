const express = require('express');
const db = require("../config/db");
const redis = require('../config/redis');

const router = express.Router();
const dailyOps = require('../controllers/dailyOperationController');
const expenses = require('../controllers/expenseController');
const reports = require('../controllers/reportController');
const stock = require('../controllers/stockController');

// ─────────────────────────────────────────────────────────────
// GET /daily-operations?branch_id=1&limit=30 — Recent entries
// ─────────────────────────────────────────────────────────────
router.get('/daily-operations', async (req, res) => {
  try {
    const branch_id = parseInt(req.query.branch_id);
    const limit = parseInt(req.query.limit) || 30;

    if (!branch_id) {
      return res.status(400).json({ message: "branch_id is required" });
    }

    const [rows] = await db.promise().query(`
      SELECT
        de.date,
        de.sold_kg,
        de.revenue,
        de.cogs,
        COALESCE(e.total_expenses, 0) as total_expenses,
        de.expenses,
        de.profit,
        de.expected_profit,
        de.closing_stock_kg,
        de.payment_cash,
        de.payment_mpesa,
        de.actual_revenue,
        de.revenue_variance
      FROM daily_entries de
      LEFT JOIN (
        SELECT branch_id, date, SUM(amount) as total_expenses
        FROM expenses
        GROUP BY branch_id, date
      ) e ON de.branch_id = e.branch_id AND de.date = e.date
      WHERE de.branch_id = ?
      ORDER BY de.date DESC
      LIMIT ?
    `, [branch_id, limit]);

    res.json(rows);
  } catch (error) {
    console.error('Daily ops error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /daily-operations/:branch_id/:date — BLOCKED
// Entries are immutable once saved. No payment updates allowed.
// ─────────────────────────────────────────────────────────────
router.patch('/daily-operations/:branch_id/:date', async (req, res) => {
  return res.status(405).json({
    message: 'Editing daily entries is not allowed. Records are final once saved.',
    code: 'METHOD_NOT_ALLOWED'
  });
});

// ─────────────────────────────────────────────────────────────
// POST /daily-operations — create only (INSERT-ONLY, no update)
// ─────────────────────────────────────────────────────────────
router.post('/daily-operations', dailyOps.createOrUpdateDailyOperation);
router.get('/daily-operations/last', dailyOps.getLastEntry);

// Expenses
router.post('/expenses', expenses.createExpense);
router.get('/expenses/:date', expenses.getExpensesByDate);
router.patch('/expenses/:id', expenses.updateExpense);   // if you need it
router.delete('/expenses/:id', expenses.deleteExpense);  // if you need it

// Reports
router.get('/reports/last-entry', reports.getLastEntryReport);
router.get('/reports/last-7-days', reports.getLast7DaysReport);
router.get('/reports/month-to-date', reports.getMonthToDateReport);

// Stock
router.get('/stock/current', stock.getCurrentStock);

module.exports = router;