const express = require('express');
const router = express.Router();
const controller = require('../controllers/expenseController');

// Create a new expense
router.post('/expenses', controller.createExpense);

// Get all expenses for a specific date (e.g., /expenses/2026-10-28)
router.get('/expenses/:date', controller.getExpensesByDate);

// Update an existing expense (e.g., /expenses/5)
router.put('/expenses/:id', controller.updateExpense);

// Delete an expense (e.g., /expenses/5)
router.delete('/expenses/:id', controller.deleteExpense);

router.get('/reports/last-7-days', controller.getLast7DaysReport);
router.get('/reports/month-to-date', controller.getMonthToDateReport);

module.exports = router;