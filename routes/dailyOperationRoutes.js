const express = require('express');
const router = express.Router();
const controller = require('../controllers/dailyOperationController');

// Create or update daily entry
router.post('/daily-operations', controller.createOrUpdateDailyOperation);

// Get last entry for a branch (used for auto-filling opening stock)
router.get('/daily-operations/last', controller.getLastEntry);

// Get entry by specific date
router.get('/daily-operations/:date', controller.getEntryByDate);

// Get totals for a specific date
router.get('/daily/:date/totals', controller.getDateTotals);

// Patch payments for a specific date (recalculates profit)
router.patch('/daily-operations/:branch_id/:date', controller.patchPayments);

module.exports = router;