const express = require('express');
const router = express.Router();
const admin = require('../controllers/adminController');

// Simple admin check — NO Firebase token verification
// Just reads x-firebase-uid from header and checks DB
// router.use(admin.requireAdmin);

// Dashboard
router.get('/stats', admin.getDashboardStats);

// Plans
router.get('/plans', admin.getAllPlans);
router.post('/plans', admin.createPlan);
router.put('/plans/:id', admin.updatePlan);
router.patch('/plans/:id/status', admin.togglePlanStatus);
router.delete('/plans/:id', admin.deletePlan);

// Users
router.get('/users', admin.getAllUsers);
router.put('/users/:id', admin.updateUser);
router.put('/users/:id/subscription', admin.updateUserSubscription);

// Payments
router.get('/payments', admin.getAllPayments);
router.post('/payments/confirm', admin.confirmPaymentManually);

// Revenue
router.get('/revenue', admin.getRevenueReport);

// Subscriptions
router.get('/subscriptions', admin.getActiveSubscriptions);
router.post('/subscriptions/:id/renew', admin.renewSubscription);
router.post('/subscriptions/:id/cancel', admin.cancelSubscription);
router.post('/subscriptions/:id/extend', admin.extendSubscription);

// Businesses
router.get('/businesses', admin.getAllBusinesses);
router.get('/businesses/:business_id/branches', admin.getBusinessBranches);

module.exports = router;