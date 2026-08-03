const express = require('express');
const router = express.Router();
const controller = require('../controllers/dailyOperationController');

router.post('/daily-operations', controller.createOrUpdateDailyOperation);
router.get('/daily-operations/last', controller.getEntryByDate);

module.exports = router;