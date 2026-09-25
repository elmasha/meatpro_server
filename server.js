const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log('Incoming:', req.method, req.url, req.headers['content-type']);
  next();
});

// ==================== PUBLIC ROUTES ====================
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

// ==================== ADMIN ROUTES ====================
// ONE mount. All admin endpoints live in routes/adminRoutes.js
// and go through requireAdmin automatically.
app.use('/api/admin', require('./routes/adminRoutes'));

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

app.get('/', (req, res) => res.send('🚀 MeatPro Backend API Running'));

app.listen(PORT, () => {
  console.log(`🚀 MeatPro Server running on port ${PORT}`);
  console.log(`🔓 Public callback: POST /api/subscriptions/callback`);
  console.log(`🔒 Admin routes mounted at /api/admin/*`);
});