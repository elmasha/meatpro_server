const express = require('express');
const router = express.Router();
const controller = require('../controllers/dailyOperationController');

router.post('/daily-operations', controller.createOrUpdateDailyOperation);
router.get('/daily-operations/last', controller.getEntryByDate);
router.get('/daily-operations/:date/totals', controller.getDateTotals);

module.exports = router;