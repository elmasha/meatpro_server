const express = require('express');
const router = express.Router();
const stockController = require('../controllers/stockController');

// Stock
router.get('/stock/current', stockController.getCurrentStock);
module.exports = router;