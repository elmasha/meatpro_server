const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Create app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging (ALL environments — helps debug callbacks)
app.use((req, res, next) => {
  console.log("Incoming:", req.method, req.url, req.headers['content-type']);
  next();
});

// ==================== PUBLIC ROUTES (No Auth Required) ====================
// M-Pesa callback — mount the CONTROLLER directly, not the router
const subscriptionController = require('./controllers/subscriptionController');
app.post('/api/subscriptions/callback', subscriptionController.mpesaCallback);

// ==================== PROTECTED ROUTES ====================
app.use('/api', require('./routes/index'));
app.use('/api', require('./routes/dailyOperationRoutes'));
app.use('/api', require('./routes/reportRoutes'));
app.use('/api', require('./routes/expenseRoutes'));
app.use('/api', require('./routes/stockRoutes'));
app.use('/api', require('./routes/subscriptionRoutes'));
app.use('/api', require('./routes/businessRoutes'));

// ==================== ADMIN ROUTES (ADDED) ====================
const adminController = require('./controllers/adminController');

// Dashboard stats
app.get('/api/admin/stats', adminController.getDashboardStats);

// Plans
app.get('/api/admin/plans', adminController.getAllPlans);
app.post('/api/admin/plans', adminController.createPlan);
app.put('/api/admin/plans/:id', adminController.updatePlan);
app.patch('/api/admin/plans/:id/status', adminController.togglePlanStatus);
app.delete('/api/admin/plans/:id', adminController.deletePlan);

// Users
app.get('/api/admin/users', adminController.getAllUsers);
app.put('/api/admin/users/:id', adminController.updateUser);
app.put('/api/admin/users/:id/subscription', adminController.updateUserSubscription);

// Subscriptions
app.get('/api/admin/subscriptions', adminController.getActiveSubscriptions);
app.post('/api/admin/subscriptions/:id/renew', adminController.renewSubscription);
app.post('/api/admin/subscriptions/:id/extend', adminController.extendSubscription);
app.post('/api/admin/subscriptions/:id/cancel', adminController.cancelSubscription);

// Payments
app.get('/api/admin/payments', adminController.getAllPayments);
app.post('/api/admin/payments/confirm', adminController.confirmPaymentManually);

// Revenue / Finance
app.get('/api/admin/revenue', adminController.getRevenueReport);

// Businesses
app.get('/api/admin/businesses', adminController.getAllBusinesses);
app.get('/api/admin/businesses/:business_id/branches', adminController.getBusinessBranches);

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => res.send("🚀 MeatPro Backend API Running"));

app.listen(PORT, () => {
  console.log(`🚀 MeatPro Server running on port ${PORT}`);
  console.log(`🔓 Public callback: POST /api/subscriptions/callback`);
  console.log(`🔒 Admin routes mounted at /api/admin/*`);
});