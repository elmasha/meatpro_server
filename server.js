// server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();

// const { verifyFirebaseToken, requireAdmin } = require('./middleware/auth_middleware');

// Create app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging (dev only)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log("Incoming:", req.method, req.url);
    next();
  });
}

// ==================== PUBLIC ROUTES (No Auth Required) ====================
// M-Pesa callback — Safaricom servers call this, cannot send Firebase token
app.use('/api/subscriptions/callback', require('./routes/subscriptionRoutes'));

// ==================== PROTECTED ROUTES (Firebase Auth Required) ====================
// Apply auth middleware to all /api/* routes below this line
// app.use('/api');

// Mount protected routes
app.use('/api', require('./routes/index'));              // dashboard routes
app.use('/api', require('./routes/dailyOperationRoutes')); // NEW: daily ops
app.use('/api', require('./routes/reportRoutes'));
app.use('/api', require('./routes/expenseRoutes'));
app.use('/api', require('./routes/stockRoutes'));
app.use('/api', require('./routes/subscriptionRoutes'));
app.use('/api', require('./routes/businessRoutes'));

// ==================== ADMIN ROUTES (Auth + Admin Check) ====================
// app.use('/api/admin',require('./routes/adminRoutes'));

// ==================== ERROR HANDLING ====================
// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Global error handler
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
  console.log(`🔒 Firebase auth enabled on /api/* routes`);
  console.log(`🔓 Public route: /api/subscriptions/callback`);
});