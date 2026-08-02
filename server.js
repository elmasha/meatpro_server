// server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();
// Create app


const app = express();

// Allow your frontend origins
const corsOptions = {
  origin: [
    'http://localhost:3000',           // Local dev
    'https://meatproserver-production-66ff.up.railway.app' // Production
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));

// IMPORTANT: Handle preflight OPTIONS requests
app.options('*', cors(corsOptions));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  console.log("Incoming:", req.method, req.url);
  next();
});
// const morgan = require('morgan');
// const helmet = require('helmet');
// const compression = require('compression');

// Routes
// const salesRoutes = require('./routes/sales');
// const businessReportRoutes = require('./routes/businessReports');
app.use('/api', require('./routes/index'));
app.use('/api', require('./routes/reportRoutes'));
app.use('/api', require('./routes/expenseRoutes'));
app.use('/api', require('./routes/stockRoutes'));
app.use('/api', require('./routes/subscriptionRoutes'));
// In your main server file
app.use('/api', require('./routes/businessRoutes'));


const adminRoutes = require('./routes/adminRoutes');

// Mount under /api/admin (after your auth middleware)
app.use('/api/admin', require('./routes/adminRoutes'));

const PORT = process.env.PORT || 5000;
// Base route
app.get("/", (req, res) => res.send("🚀 MeatPro Backend API Running "));
// 🔹 Start Server
app.listen(PORT, () => {
    console.log(`🚀 MeatPro Server running on port ${PORT}`);
});