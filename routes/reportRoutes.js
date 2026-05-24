const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');

// Existing endpoints (DASHBOARD uses these)
router.get('/reports/last-entry', reportController.getLastEntryReport);
router.get('/reports/last-7-days', reportController.getLast7DaysReport);
router.get('/reports/month-to-date', reportController.getMonthToDateReport);

// NEW: Analytics endpoints (REPORTS page uses these)
router.get('/reports/waste-analysis', reportController.getWasteAnalysis);
router.get('/reports/payment-mix', reportController.getPaymentMix);
router.get('/reports/profitability', reportController.getProfitability);
router.get('/reports/expense-breakdown', reportController.getExpenseBreakdown);
router.get('/reports/comparative', reportController.getComparative);

module.exports = router;