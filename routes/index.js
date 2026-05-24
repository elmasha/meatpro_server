const express = require('express');
const db = require("../config/db");
const redis = require('../config/redis');

const router = express.Router();
const dailyOps = require('../controllers/dailyOperationController');
const expenses = require('../controllers/expenseController');
const reports = require('../controllers/reportController');
const stock = require('../controllers/stockController');


// GET /daily-operations/last?branch_id=1
// Returns the most recent entry for auto-filling opening stock
router.get('/daily-operations/last', async (req, res) => {
  try {
    const { branch_id } = parseInt(req.query);
    const [rows] = await db.promise().execute(
      `SELECT * FROM daily_entries 
       WHERE branch_id = ? 
       ORDER BY date DESC, id DESC 
       LIMIT 1`,
      [branch_id || 1]
    );
    res.json(rows[0] || null);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /daily-operations?branch_id=1&limit=10
// Recent entries table
router.get('/daily-operations', async (req, res) => {
  try {
    const { branch_id, limit = 10 } = parseInt(req.query);
    const [rows] = await db.promise().execute(
      `SELECT date, sold_kg, revenue, (sold_kg * cost_per_kg) as total_cost, 
              profit, closing_stock_kg 
       FROM daily_entries 
       WHERE branch_id = ? 
       ORDER BY date DESC 
       LIMIT ?`,
      [branch_id || 1, parseInt(limit)]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PATCH /daily-operations/:branch_id/:date
// Update only payment fields
router.patch('/daily-operations/:branch_id/:date', async (req, res) => {
  try {
    const { payment_cash, payment_mpesa } = req.body;
    await db.promise().execute(
      `UPDATE daily_entries 
       SET payment_cash = ?, payment_mpesa = ? 
       WHERE branch_id = ? AND date = ?`,
      [payment_cash || 0, payment_mpesa || 0, req.params.branch_id, req.params.date]
    );
    res.json({ message: 'Payments updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Daily Operations
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


// routes/dashboard.js or add to your existing router




module.exports = router;