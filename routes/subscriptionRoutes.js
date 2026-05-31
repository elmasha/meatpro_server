const express = require('express');
const router = express.Router();
const subscription = require('../controllers/subscriptionController');

router.get('/plans', subscription.getPlans);
router.get('/subscriptions/status', subscription.getStatus);
router.get('/subscriptions/history', subscription.getPaymentHistory);
router.post('/subscriptions/initiate', subscription.initiatePayment);
router.post('/subscriptions/callback', subscription.mpesaCallback);
router.post('/subscriptions/confirm', subscription.confirmDemo);
router.post('/subscriptions/cancel', subscription.cancelSubscription);

module.exports = router;