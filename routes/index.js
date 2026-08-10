const express = require('express');
const db = require("../config/db");
const redis = require('../config/redis');

const router = express.Router();
const dailyOps = require('../controllers/dailyOperationController');
const expenses = require('../controllers/expenseController');
const reports = require('../controllers/reportController');
const stock = require('../controllers/stockController');

// GET /daily-operations?branch_id=1&limit=10
router.get('/daily-operations', async (req, res) => {
  try {
    const branch_id = parseInt(req.query.branch_id) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const [rows] = await db.promise().query(
      `SELECT date, sold_kg, revenue, (sold_kg * cost_per_kg) as total_cost, 
              profit, closing_stock_kg 
       FROM daily_entries 
       WHERE branch_id = ? 
       ORDER BY date DESC 
       LIMIT ?`,
      [branch_id, limit]
    );
    res.json(rows);
  } catch (error) {
    console.error('Daily ops error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET /daily-operations/last?branch_id=1
// Uses the CONTROLLER — not inline — so actual revenue/profit calculations run
router.get('/daily-operations/last', dailyOps.getLastEntry);

// GET /daily-operations/:date?branch_id=1
router.get('/daily-operations/:date', dailyOps.getEntryByDate);

// PATCH /daily-operations/:branch_id/:date
// Updates payments AND recalculates profit via controller
router.patch('/daily-operations/:branch_id/:date', async (req, res) => {
  try {
    const { payment_cash, payment_mpesa } = req.body;
    const cash = parseFloat(payment_cash) || 0;
    const mpesa = parseFloat(payment_mpesa) || 0;
    const branch_id = parseInt(req.params.branch_id);
    const date = req.params.date;

    // Update payments
    await db.promise().query(
      `UPDATE daily_entries 
       SET payment_cash = ?, payment_mpesa = ? 
       WHERE branch_id = ? AND date = ?`,
      [cash, mpesa, branch_id, date]
    );

    // Recalculate profit using the controller's logic
    const [rows] = await db.promise().execute(
      `SELECT * FROM daily_entries WHERE date = ? AND branch_id = ?`,
      [date, branch_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Entry not found" });
    }

    const entry = rows[0];
    const actualRevenue = cash + mpesa;
    const cogs = (parseFloat(entry.sold_kg) || 0) * (parseFloat(entry.cost_per_kg) || 0);

    // Get real expenses
    const [expRows] = await db.promise().execute(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date = ? AND branch_id = ?`,
      [date, branch_id]
    );
    const totalExpenses = parseFloat(expRows[0].total) || 0;

    const profit = actualRevenue - cogs - totalExpenses;

    // Write recalculated profit back
    await db.promise().query(
      `UPDATE daily_entries SET profit = ? WHERE branch_id = ? AND date = ?`,
      [profit, branch_id, date]
    );

    // Invalidate cache
    const keys = [
      `stock:current:${branch_id}`,
      `report:last-entry:${branch_id}`,
      `report:last-7-days:${branch_id}`,
      `report:month-to-date:${branch_id}`
    ];
    for (const key of keys) {
      await redis.del(key);
    }

    res.json({ 
      message: 'Payments and profit updated',
      actualRevenue,
      cogs,
      totalExpenses,
      profit
    });
  } catch (error) {
    console.error('Patch error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Daily Operations
router.post('/daily-operations', dailyOps.createOrUpdateDailyOperation);

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