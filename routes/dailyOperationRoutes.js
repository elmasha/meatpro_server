const express = require('express');
const router = express.Router();
const controller = require('../controllers/dailyOperationController');

router.post('/daily-operations', controller.createOrUpdateDailyOperation);
router.get('/daily-operations/last', controller.getLastEntry);        // FIXED: was getEntryByDate
router.get('/daily-operations/:date', controller.getEntryByDate);     // ADDED: was orphaned
// router.get('/daily/:date/totals', controller.getDateTotals);

module.exports = router;