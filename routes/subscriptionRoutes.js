const express = require('express');
const router = express.Router();
const subscription = require('../controllers/subscriptionController');

// NOTE: /callback is handled directly in server.js as a public route
// All routes here are protected by verifyFirebaseToken middleware

router.get('/plans', subscription.getPlans);
router.get('/subscriptions/status', subscription.getStatus);
router.get('/subscriptions/history', subscription.getPaymentHistory);
router.post('/subscriptions/initiate', subscription.initiatePayment);
router.post('/subscriptions/query', subscription.queryStkStatus);
router.post('/subscriptions/confirm', subscription.confirmDemo);
router.post('/subscriptions/cancel', subscription.cancelSubscription);

module.exports = router;