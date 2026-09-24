const express = require('express');
const db = require("../config/db");
const redis = require('../config/redis');

const router = express.Router();
const dailyOps = require('../controllers/dailyOperationController');
const expenses = require('../controllers/expenseController');
const reports = require('../controllers/reportController');
const stock = require('../controllers/stockController');

// ─────────────────────────────────────────────────────────────
// GET /daily-operations?branch_id=1&limit=10 — Recent entries
// Uses a pre-aggregated expenses subquery to avoid fragile GROUP BY
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

    // Ensure COGS is present (fallback for legacy rows)
    const results = rows.map(r => ({
      ...r,
      cogs: parseFloat(r.cogs) || (parseFloat(r.sold_kg) * 0) // cogs stored; keep as-is
    }));

    res.json(results);
  } catch (error) {
    console.error('Daily ops error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /daily-operations/:branch_id/:date — Update only payment fields
// Recomputes dependent fields (actual_revenue, variance, profit)
// ─────────────────────────────────────────────────────────────
router.patch('/daily-operations/:branch_id/:date', async (req, res) => {
  try {
    const { payment_cash, payment_mpesa } = req.body;
    const cash = parseFloat(payment_cash) || 0;
    const mpesa = parseFloat(payment_mpesa) || 0;
    const branch_id = parseInt(req.params.branch_id);
    const date = req.params.date;

    // Fetch the existing row so we can recompute profit & variance
    const [existingRows] = await db.promise().query(
      `SELECT revenue, expenses FROM daily_entries WHERE branch_id = ? AND date = ?`,
      [branch_id, date]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ message: 'Entry not found' });
    }

    const expectedRevenue = parseFloat(existingRows[0].revenue) || 0;
    const totalExpenses = parseFloat(existingRows[0].expenses) || 0;
    const actualRevenue = cash + mpesa;
    const revenueVariance = expectedRevenue - actualRevenue;

    // ✅ Profit = Revenue − Expenses only (COGS NOT subtracted)
    const profit = actualRevenue - totalExpenses;
    const expectedProfit = expectedRevenue - totalExpenses;

    await db.promise().query(`
      UPDATE daily_entries
      SET payment_cash = ?,
          payment_mpesa = ?,
          actual_revenue = ?,
          revenue_variance = ?,
          profit = ?,
          expected_profit = ?
      WHERE branch_id = ? AND date = ?
    `, [cash, mpesa, actualRevenue, revenueVariance, profit, expectedProfit, branch_id, date]);

    // Invalidate caches
    const keys = [
      `daily:last:${branch_id}`,
      `report:last-entry:${branch_id}`,
      `report:last-7-days:${branch_id}`,
      `report:month-to-date:${branch_id}`,
      `stock:current:${branch_id}`
    ];
    for (const key of keys) { await redis.del(key); }

    res.json({ message: 'Payments updated', actualRevenue, profit });
  } catch (error) {
    console.error('Patch error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Daily Operations — controller routes
// ─────────────────────────────────────────────────────────────
router.post('/daily-operations', dailyOps.createOrUpdateDailyOperation);
router.get('/daily-operations/last', dailyOps.getLastEntry);

// Expenses
router.post('/expenses', expenses.createExpense);
router.get('/expenses/:date', expenses.getExpensesByDate);

// Reports
router.get('/reports/last-entry', reports.getLastEntryReport);
router.get('/reports/last-7-days', reports.getLast7DaysReport);
router.get('/reports/month-to-date', reports.getMonthToDateReport);

// Stock
router.get('/stock/current', stock.getCurrentStock);

module.exports = router;