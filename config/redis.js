// const redis = require('redis');
// require('dotenv').config();

// const client = redis.createClient({
//     socket: {
//         host: '127.0.0.1',  // <-- Hardcode IPv4, ignore env
//         port: parseInt(process.env.REDIS_PORT) || 6379,
//     }
// });

// client.on('connect', () => {
//     console.log('✅ Redis connected');
// });

// client.on('error', (err) => {
//     console.error('❌ Redis error:', err.message);
// });

// client.connect()
//     .then(() => client.ping())
//     .then((response) => console.log('✅ Redis PING:', response))
//     .catch((err) => console.error('Redis connection failed:', err.message));

// module.exports = client;


const { createClient } = require('redis');
require('dotenv').config();

// Create Redis client using REDIS_URL (from Railway)
const client = createClient({
  url: process.env.REDIS_URL,  // use full URL
});

// Event: Connected
client.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

// Event: Error
client.on('error', (err) => {
  console.error('❌ Redis connection error:', err.message);
});

// Connect and test
(async () => {
  try {
    await client.connect();
    const pong = await client.ping();
    console.log('✅ Redis PING:', pong); // Should print "PONG"
  } catch (err) {
    console.error('❌ Redis error:', err.message);
  }
})();

// Export client
module.exports = client;

