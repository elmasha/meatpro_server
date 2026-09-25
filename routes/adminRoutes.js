// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { requireAdmin, requireRole } = require('../middleware/adminAuth');
const admin = require('../controllers/adminController');

router.use(requireAdmin);

router.get('/me', (req, res) => res.json({ success: true, admin: req.admin }));
router.get('/stats', admin.getDashboardStats);

router.get('/plans', admin.getAllPlans);
router.post('/plans', admin.createPlan);
router.put('/plans/:id', admin.updatePlan);
router.patch('/plans/:id/status', admin.togglePlanStatus);
router.delete('/plans/:id', admin.deletePlan);

router.get('/users', admin.getAllUsers);
router.put('/users/:id', admin.updateUser);
router.put('/users/:id/subscription', admin.updateUserSubscription);
router.post('/users/:id/trial', admin.startTrial);
router.delete('/users/:id', admin.deleteUser);

router.get('/payments', admin.getAllPayments);
router.post('/payments/confirm', admin.confirmPaymentManually);

router.get('/revenue', admin.getRevenueReport);

router.get('/subscriptions', admin.getActiveSubscriptions);
router.post('/subscriptions/:id/renew', admin.renewSubscription);
router.post('/subscriptions/:id/cancel', admin.cancelSubscription);
router.post('/subscriptions/:id/extend', admin.extendSubscription);

router.get('/businesses', admin.getAllBusinesses);
router.get('/businesses/:business_id/branches', admin.getBusinessBranches);

router.get('/change-requests', requireRole('super_admin'), admin.getPendingChangeRequests);
router.get('/change-requests/:code', requireRole('super_admin'), admin.getChangeRequestByCode);
router.post('/change-requests/:code/decide', requireRole('super_admin'), admin.decideChangeRequest);
router.post('/users/:id/send-password-reset',
  requireRole('super_admin'),
  admin.sendPasswordReset);
module.exports = router;