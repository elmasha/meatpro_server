// server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Create app
const app = express();

// ===== EXPLICIT CORS CONFIG =====
// Allow all origins in development, restrict in production
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  // Add your production frontend URLs here:
   'https://meatproserver-production-66ff.up.railway.app',
  // 'https://your-app.netlify.app'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      console.warn('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Length', 'X-Total-Count'],
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// Handle preflight for ALL routes
app.options('*', cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log("Incoming:", req.method, req.url, "Origin:", req.headers.origin || "none");
  next();
});

// ===== HEALTH CHECK / CORS TEST =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cors: 'enabled',
    origin: req.headers.origin || 'none'
  });
});

// ===== ROUTES =====
app.use('/api', require('./routes/index'));
app.use('/api', require('./routes/reportRoutes'));
app.use('/api', require('./routes/expenseRoutes'));
app.use('/api', require('./routes/stockRoutes'));
app.use('/api', require('./routes/subscriptionRoutes'));
app.use('/api', require('./routes/businessRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));

// Base route
app.get("/", (req, res) => res.send("🚀 MeatPro Backend API Running"));

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 MeatPro Server running on port ${PORT}`);
  console.log(`📝 CORS allowed origins:`, allowedOrigins);
});