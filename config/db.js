// const mysql = require('mysql2');  // <-- change from 'mysql' to 'mysql2'

// const db = mysql.createConnection({
//   host: 'localhost',
//   user: 'root',
//   password: '',
//   database: 'test_meatpro'
// });

// db.connect((err) => {
//   if (err) {
//     console.log('❌ No connection to database:', err.message);
//   } else {
//     console.log('💾 Connected to database');
//   }
// });

// module.exports = db;


const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

pool.on('connection', () => {
  console.log('✅ MySQL pool connection established');
});

module.exports = pool;

