
// server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();
// Create app
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
// In your main server file
app.use('/api', require('./routes/businessRoutes'));




const PORT = process.env.PORT || 5000;
// Base route
app.get("/", (req, res) => res.send("🚀 MeatPro Backend API Running "));
// 🔹 Start Server
app.listen(PORT, () => {
    console.log(`🚀 MeatPro Server running on port ${PORT}`);
});