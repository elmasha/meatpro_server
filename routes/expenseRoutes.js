const express = require('express');
const router = express.Router();
const controller = require('../controllers/expenseController');

router.post('/expenses', controller.createExpense);
router.get('/expenses/:date', controller.getExpensesByDate);

module.exports = router;