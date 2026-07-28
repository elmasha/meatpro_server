const db = require('../config/db');
const redis = require('../config/redis');
const request = require('request');
const moment = require('moment');



// ── M-Pesa Helper ────────────────────────────────────────────────────
async function getMpesaToken() {
  const consumerKey = process.env.PROD_CONSUMER_KEY_DEV;
  const consumerSecret = process.env.PROD_SECRET_KEY_DEV;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  return new Promise((resolve, reject) => {
    request.get(
      {
        url: 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        headers: { Authorization: `Basic ${auth}` },
        json: true
      },
      (error, response, body) => {
        if (error) return reject(error);
        if (response.statusCode !== 200) return reject(new Error(`Token request failed: ${response.statusCode}`));
        resolve(body.access_token);
      }
    );
  });
}

// ── User Helpers ─────────────────────────────────────────────────────
async function getUserId(firebase_uid) {
  const [rows] = await db.promise().query(
    'SELECT id FROM users WHERE firebase_uid = ?', [firebase_uid]
  );
  return rows[0]?.id || null;
}

async function getUserPhone(userId) {
  const [rows] = await db.promise().query(
    'SELECT phone FROM users WHERE id = ? LIMIT 1', [userId]
  );
  return rows[0]?.phone || null;
}

function invalidateUserCache(firebase_uid) {
  redis.del(`sub:status:${firebase_uid}`).catch(() => {});
}

// ── GET /api/plans ───────────────────────────────────────────────────
exports.getPlans = async (req, res) => {
  try {
    const [plans] = await db.promise().query(
      'SELECT * FROM plans WHERE is_active = 1 ORDER BY price_kes ASC'
    );
    res.json(plans);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/subscriptions/status ────────────────────────────────────
exports.getStatus = async (req, res) => {
  try {
    const firebase_uid = req.query.firebase_uid;
    if (!firebase_uid) return res.status(400).json({ message: 'firebase_uid required' });

    const cacheKey = `sub:status:${firebase_uid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [rows] = await db.promise().query(`
      SELECT 
        s.id, s.status, s.plan, s.end_date, s.plan_id, s.start_date,
        p.display_name, p.price_kes, p.features
      FROM subscriptions s
      LEFT JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
      LIMIT 1
    `, [userId]);

    if (!rows.length) {
      const response = { subscription: null, is_active: false, days_remaining: 0, message: 'No subscription found' };
      await redis.setEx(cacheKey, 60, JSON.stringify(response));
      return res.json(response);
    }

    const sub = rows[0];
    const endDate = sub.end_date ? moment(sub.end_date) : null;
    const daysRemaining = endDate ? endDate.diff(moment(), 'days') : 0;
    const isActive = sub.status === 'active' && endDate && endDate.isAfter(moment());

    const response = {
      subscription: {
        id: sub.id,
        plan: sub.plan,
        plan_id: sub.plan_id,
        status: sub.status,
        start_date: sub.start_date,
        end_date: sub.end_date,
        display_name: sub.display_name || sub.plan || 'Starter',
        price_kes: parseFloat(sub.price_kes) || 0,
        features: sub.features
      },
      is_active: isActive,
      days_remaining: Math.max(0, daysRemaining)
    };

    await redis.setEx(cacheKey, 60, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    console.error('getStatus error:', error);
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/subscriptions/history ───────────────────────────────────
exports.getPaymentHistory = async (req, res) => {
  try {
    const firebase_uid = req.query.firebase_uid;
    if (!firebase_uid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [payments] = await db.promise().query(
      `SELECT id, amount, phone, mpesa_receipt, checkout_request_id, transaction_date, created_at 
       FROM payments WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );

    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/subscriptions/latest-receipt ────────────────────────────
exports.getLatestReceipt = async (req, res) => {
  try {
    const firebase_uid = req.query.firebase_uid;
    if (!firebase_uid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [rows] = await db.promise().query(
      `SELECT mpesa_receipt, checkout_request_id, amount, created_at 
       FROM payments 
       WHERE user_id = ? AND mpesa_receipt IS NOT NULL AND mpesa_receipt != 'FAILED'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ message: 'No receipt found' });

    res.json({
      receipt: rows[0].mpesa_receipt,
      checkout_request_id: rows[0].checkout_request_id,
      amount: rows[0].amount,
      date: rows[0].created_at
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/subscriptions/initiate ─────────────────────────────────
exports.initiatePayment = async (req, res) => {
  try {
    const { firebase_uid, plan_id, phone } = req.body;
    if (!firebase_uid || !plan_id || !phone) {
      return res.status(400).json({ message: 'firebase_uid, plan_id, and phone required' });
    }

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [plans] = await db.promise().query(
      'SELECT * FROM plans WHERE id = ? AND is_active = 1', [plan_id]
    );
    if (!plans.length) return res.status(400).json({ message: 'Invalid plan' });

    const plan = plans[0];
    const reference = `MPESA_${Date.now()}_${userId}`;

    const [subResult] = await db.promise().query(
      `INSERT INTO subscriptions (user_id, plan_id, plan, amount, start_date, end_date, status, payment_reference, created_at)
       VALUES (?, ?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 MONTH), 'pending', ?, NOW())`,
      [userId, plan.id, plan.name, plan.price_kes, reference]
    );

    const [paymentResult] = await db.promise().query(
      `INSERT INTO payments (user_id, amount, phone, subscription, checkout_request_id, mpesa_receipt, transaction_date, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NOW())`,
      [userId, plan.price_kes, phone, plan.name, reference]
    );

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const shortcode = process.env.PROD_SHORTCODE_DEV;
    const passkey = process.env.PROD_PASSKEY_DEV;
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const stkResponse = await new Promise((resolve, reject) => {
      request.post(
        {
          url: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.ceil(plan.price_kes),
            PartyA: phone,
            PartyB: shortcode,
            PhoneNumber: phone,
            CallBackURL: `${process.env.BASE_URL}/api/subscriptions/callback`,
            AccountReference: `MeatPro_${userId}`,
            TransactionDesc: `MeatPro ${plan.display_name}`
          })
        },
        (error, response, body) => {
          if (error) return reject(error);
          if (response.statusCode !== 200) return reject(new Error(`STK push failed: ${response.statusCode} - ${body}`));
          resolve(JSON.parse(body));
        }
      );
    });

    if (stkResponse.CheckoutRequestID) {
      await db.promise().query(
        `UPDATE payments SET checkout_request_id = ? WHERE id = ?`,
        [stkResponse.CheckoutRequestID, paymentResult.insertId]
      );
    }

    res.json({
      message: 'Payment initiated. Check your phone for M-Pesa prompt.',
      subscription_id: subResult.insertId,
      amount: plan.price_kes,
      phone: phone,
      reference: reference,
      checkout_request_id: stkResponse.CheckoutRequestID || null,
      merchant_request_id: stkResponse.MerchantRequestID || null,
      response_code: stkResponse.ResponseCode,
      response_description: stkResponse.ResponseDescription,
      demo_mode: true
    });
  } catch (error) {
    console.error('Initiate error:', error);
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/subscriptions/callback ─────────────────────────────────
exports.mpesaCallback = async (req, res) => {
  const connection = await db.promise().getConnection();
  try {
    await connection.beginTransaction();

    const { Body } = req.body;
    const result = Body.stkCallback;
    const checkoutRequestId = result.CheckoutRequestID;

    if (result.ResultCode === 0) {
      const items = result.CallbackMetadata.Item;
      const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const phone = items.find(i => i.Name === 'PhoneNumber')?.Value;
      const transactionDate = items.find(i => i.Name === 'TransactionDate')?.Value;

      const [paymentRows] = await connection.query(
        'SELECT user_id, id FROM payments WHERE checkout_request_id = ?',
        [checkoutRequestId]
      );

      if (!paymentRows.length) {
        await connection.rollback();
        connection.release();
        return res.json({ ResultCode: 0, ResultDesc: 'Received' });
      }

      const userId = paymentRows[0].user_id;

     await connection.query(
        `UPDATE payments SET mpesa_receipt = ?,status = ?, transaction_date = ? WHERE checkout_request_id = ? AND user_id = ?`,
        [receipt, 'success', transactionDate, checkoutRequestId, userId]
      );


      await connection.query(
        `UPDATE subscriptions SET status = 'active', start_date = CURDATE(), end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), mpesa_receipt = ?
         WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
        [receipt, userId]
      );

      await connection.query(
        `UPDATE users SET subscription = 'pro', subscription_status = 'active', subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH),
         mpesa_receipt = ?, payment_date = NOW() WHERE id = ?`,
        [receipt, userId]
      );

      await connection.commit();

  
      invalidateUserCache(userId);
    } else {
      await connection.query(
        `UPDATE payments SET mpesa_receipt = 'FAILED' WHERE checkout_request_id = ?`,
        [checkoutRequestId]
      );
      await connection.commit();
    }

    connection.release();
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error('Callback error:', error);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
  }
};

// ── POST /api/subscriptions/confirm (Demo) ───────────────────────────
exports.confirmDemo = async (req, res) => {
  const connection = await db.promise().getConnection();
  try {
    await connection.beginTransaction();

    const { subscription_id, firebase_uid } = req.body;
    if (!subscription_id || !firebase_uid) {
      connection.release();
      return res.status(400).json({ message: 'subscription_id and firebase_uid required' });
    }

    const userId = await getUserId(firebase_uid);
    if (!userId) {
      connection.release();
      return res.status(404).json({ message: 'User not found' });
    }

    const [paymentRows] = await connection.query(
      `SELECT mpesa_receipt, phone FROM payments 
       WHERE user_id = ? AND mpesa_receipt IS NOT NULL AND mpesa_receipt != 'FAILED'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    const realReceipt = paymentRows[0]?.mpesa_receipt || 'DEMO_RECEIPT';
    const phone = paymentRows[0]?.phone || await getUserPhone(userId);

    const [subs] = await connection.query(
      'SELECT plan, plan_id FROM subscriptions WHERE id = ? AND user_id = ?',
      [subscription_id, userId]
    );

    const planName = subs[0]?.plan || 'pro';

    await connection.query(
      `UPDATE subscriptions SET status = 'active', start_date = CURDATE(), end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), mpesa_receipt = ?
       WHERE id = ? AND user_id = ?`,
      [realReceipt, subscription_id, userId]
    );

    await connection.query(
      `UPDATE users SET subscription = ?, subscription_status = 'active', subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH),
       mpesa_receipt = ?, payment_date = NOW() WHERE id = ?`,
      [planName, realReceipt, userId]
    );

    await connection.commit();
    connection.release();

  
    invalidateUserCache(firebase_uid);
    res.json({ message: 'Subscription activated successfully', receipt_used: realReceipt });
  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error('confirmDemo error:', error);
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/subscriptions/cancel ───────────────────────────────────
exports.cancelSubscription = async (req, res) => {
  try {
    const { firebase_uid } = req.body;
    if (!firebase_uid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const connection = await db.promise().getConnection();
    try {
      await connection.beginTransaction();

      const [subResult] = await connection.query(
        `UPDATE subscriptions 
         SET status = 'cancelled'
         WHERE user_id = ? AND status = 'active'
         ORDER BY end_date DESC LIMIT 1`,
        [userId]
      );

      if (subResult.affectedRows === 0) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({ message: 'No active subscription to cancel' });
      }

      await connection.query(
        `UPDATE users 
         SET subscription_status = 'cancelled'
         WHERE id = ?`,
        [userId]
      );

      await connection.commit();
      connection.release();
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }

    invalidateUserCache(firebase_uid);
    res.json({ message: 'Subscription cancelled. You can use Pro features until expiry.' });
  } catch (error) {
    console.error('cancelSubscription error:', error);
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/subscriptions/query ────────────────────────────────────
exports.queryStkStatus = async (req, res) => {
  try {
    const { checkout_request_id } = req.body;
    if (!checkout_request_id) return res.status(400).json({ message: 'checkout_request_id is required' });

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const shortcode = process.env.PROD_SHORTCODE_DEV;
    const passkey = process.env.PROD_PASSKEY_DEV;
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const queryResponse = await new Promise((resolve, reject) => {
      request.post(
        {
          url: 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          json: { BusinessShortCode: shortcode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkout_request_id }
        },
        (error, response, body) => {
          if (error) return reject(error);
          resolve({ statusCode: response.statusCode, body });
        }
      );
    });

    const result = queryResponse.body;
    res.json({
      success: true,
      status: result.ResultCode === '0' ? 'success' : 'pending',
      result_code: result.ResultCode,
      result_desc: result.ResultDesc,
      checkout_request_id,
      raw_response: result
    });
  } catch (error) {
    console.error('STK Query error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};