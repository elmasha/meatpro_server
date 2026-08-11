const express = require('express');
const db = require("../config/db");
const redis = require('../config/redis');

const router = express.Router();
const dailyOps = require('../controllers/dailyOperationController');
const expenses = require('../controllers/expenseController');
const reports = require('../controllers/reportController');
const stock = require('../controllers/stockController');

// GET /daily-operations?branch_id=1&limit=10 — Recent entries table
router.get('/daily-operations', async (req, res) => {
  try {
    const branch_id = parseInt(req.query.branch_id) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const [rows] = await db.promise().query(`
      SELECT date, sold_kg, revenue, (sold_kg * cost_per_kg) as total_cost, 
             profit, closing_stock_kg, payment_cash, payment_mpesa,
             actual_revenue, revenue_variance
      FROM daily_entries 
      WHERE branch_id = ? 
      ORDER BY date DESC 
      LIMIT ?
    `, [branch_id, limit]);
    res.json(rows);
  } catch (error) {
    console.error('Daily ops error:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /daily-operations/:branch_id/:date — Update only payment fields
router.patch('/daily-operations/:branch_id/:date', async (req, res) => {
  try {
    const { payment_cash, payment_mpesa } = req.body;
    const cash = parseFloat(payment_cash) || 0;
    const mpesa = parseFloat(payment_mpesa) || 0;
    const branch_id = parseInt(req.params.branch_id);
    const date = req.params.date;

    await db.promise().query(`
      UPDATE daily_entries 
      SET payment_cash = ?, payment_mpesa = ? 
      WHERE branch_id = ? AND date = ?
    `, [cash, mpesa, branch_id, date]);

    res.json({ message: 'Payments updated' });
  } catch (error) {
    console.error('Patch error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Daily Operations — controller routes (NO DUPLICATE /last here)
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