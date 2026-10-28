const express = require('express');
const router = express.Router();

const dailyOps = require('../controllers/dailyOperationController');
const expenses = require('../controllers/expenseController');

// ─────────────────────────────────────────────────────────────
// DAILY OPERATIONS
// ─────────────────────────────────────────────────────────────
router.post('/daily-operations', dailyOps.createOrUpdateDailyOperation);
router.get('/daily-operations/last', dailyOps.getLastEntry);
router.get('/daily-operations/:date', dailyOps.getEntryByDate);

// ─────────────────────────────────────────────────────────────
// EXPENSES----
// ─────────────────────────────────────────────────────────────
router.post('/expenses', expenses.createExpense);
router.get('/expenses/:date', expenses.getExpensesByDate);

// ─────────────────────────────────────────────────────────────
// REPORTS (MUST POINT TO expenses, NOT reports)
// ─────────────────────────────────────────────────────────────
router.get('/reports/last-7-days', expenses.getLast7DaysReport);
router.get('/reports/month-to-date', expenses.getMonthToDateReport);

module.exports = router;