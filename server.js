
// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Create app
const app = express();
app.use(cors());
// app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// const morgan = require('morgan');
// const helmet = require('helmet');
// const compression = require('compression');

// Routes
// const salesRoutes = require('./routes/sales');
// const businessReportRoutes = require('./routes/businessReports');
app.use(express.json());
app.use('/api', require('./routes/index'));
app.use('/api', require('./routes/reportRoutes'));
app.use('/api', require('./routes/expenseRoutes'));
app.use('/api', require('./routes/stockRoutes'));
// In your main server file
app.use('/api', require('./routes/businessRoutes'));



const PORT = process.env.PORT || 5000;

// 🔹 Start Server
app.listen(PORT, () => {
    console.log(`🚀 MeatPro Server running on port ${PORT}`);
});