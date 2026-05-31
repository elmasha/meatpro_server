const db = require('../config/db');
const request = require('request');

// Helper: Get M-Pesa access token
async function getMpesaToken() {
  const consumerKey = process.env.MP_CONSUMER_KEY_DEV;
  const consumerSecret = process.env.MP_SECRET_KEY_DEV;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  return new Promise((resolve, reject) => {
    request.get(
      {
        url: 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
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

// Helper: Get user_id from firebase_uid
async function getUserId(firebase_uid) {
  const [rows] = await db.promise().query(
    'SELECT id FROM users WHERE firebase_uid = ?', [firebase_uid]
  );
  return rows[0]?.id || null;
}

// ==================== GET PLANS ====================
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

// ==================== GET SUBSCRIPTION STATUS ====================
exports.getStatus = async (req, res) => {
  try {
    const firebase_uid = req.query.firebase_uid;
    if (!firebase_uid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [rows] = await db.promise().query(`
      SELECT 
        s.status, s.plan, s.end_date, s.plan_id, s.payment_reference,
        p.display_name, p.price_kes, p.features
      FROM subscriptions s
      LEFT JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
      LIMIT 1
    `, [userId]);

    let subscription = rows[0];

    if (!subscription) {
      const [userRows] = await db.promise().query(
        'SELECT subscription, subscription_status, subscription_expires FROM users WHERE id = ?',
        [userId]
      );
      const userSub = userRows[0];

      subscription = {
        status: userSub?.subscription_status || 'expired',
        plan: userSub?.subscription || 'starter',
        display_name: userSub?.subscription === 'pro' ? 'Professional' : 'Starter (Free)',
        end_date: userSub?.subscription_expires,
        features: userSub?.subscription === 'pro' 
          ? '["Unlimited branches","Advanced analytics","Waste alerts","Full history + CSV export","Multi-user access"]'
          : '["1 branch","Daily operations","Basic profit summary","7-day history"]'
      };
    }

    const isActive = (subscription.status === 'active' || subscription.status === 'free') && 
      subscription.end_date && new Date(subscription.end_date) > new Date();

    const daysRemaining = isActive 
      ? Math.ceil((new Date(subscription.end_date) - new Date()) / (1000 * 60 * 60 * 24))
      : 0;

    res.json({
      subscription,
      is_active: isActive,
      days_remaining: daysRemaining,
      features: typeof subscription.features === 'string' 
        ? JSON.parse(subscription.features) 
        : subscription.features
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ==================== GET PAYMENT HISTORY ====================
exports.getPaymentHistory = async (req, res) => {
  try {
    const firebase_uid = req.query.firebase_uid;
    if (!firebase_uid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [payments] = await db.promise().query(
      `SELECT id, amount, phone, mpesa_receipt, checkout_request_id, transaction_date, created_at, status
       FROM payments WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );

    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ==================== GET LATEST RECEIPT ====================
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
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'No receipt found' });
    }

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

// ==================== INITIATE PAYMENT (STK Push) ====================
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
      `INSERT INTO payments (user_id, amount, phone, subscription, checkout_request_id, mpesa_receipt, transaction_date, created_at, status)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NOW(), 'pending')`,
      [userId, plan.price_kes, phone, plan.name, reference]
    );

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const shortcode = process.env.MP_SHORTCODE_DEV;
    const passkey = process.env.MP_PASSKEY_DEV;
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const stkResponse = await new Promise((resolve, reject) => {
      request.post(
        {
          url: 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.ceil(plan.price_kes),
            PartyA: phone,
            PartyB: shortcode,
            PhoneNumber: phone,
            CallBackURL: `https://meatproserver-production-6328.up.railway.app/api/subscriptions/callback`,
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

    console.log('STK Response:', stkResponse);

    if (stkResponse.CheckoutRequestID) {
      await db.promise().query(
        `UPDATE payments 
         SET checkout_request_id = ?
         WHERE id = ?`,
        [stkResponse.CheckoutRequestID, paymentResult.insertId]
      );
    }

    res.json({
      message: 'Payment initiated. Check your phone for M-Pesa prompt.',
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

// ==================== NEW: STK QUERY (Check Payment Status) ====================
exports.queryStkStatus = async (req, res) => {
  try {
    const { checkout_request_id } = req.body;

    if (!checkout_request_id) {
      return res.status(400).json({ message: 'checkout_request_id is required' });
    }

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const shortcode = process.env.MP_SHORTCODE_DEV;
    const passkey = process.env.MP_PASSKEY_DEV;
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const queryResponse = await new Promise((resolve, reject) => {
      request.post(
        {
          url: 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            CheckoutRequestID: checkout_request_id
          })
        },
        (error, response, body) => {
          if (error) return reject(error);
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(body)
          });
        }
      );
    });

    const result = queryResponse.body;

    // If payment was successful, auto-confirm it
    if (result.ResultCode === '0') {
      // Find the payment record
      const [paymentRows] = await db.promise().query(
        'SELECT user_id, id FROM payments WHERE checkout_request_id = ?',
        [checkout_request_id]
      );

      if (paymentRows.length > 0) {
        const userId = paymentRows[0].user_id;
        const paymentId = paymentRows[0].id;

        // Get receipt from result if available
        const receipt = result.ResultDesc || 'STK_CONFIRMED';

        // Update payment status
        await db.promise().query(
          `UPDATE payments 
           SET status = 'success', mpesa_receipt = ?
           WHERE id = ?`,
          [receipt, paymentId]
        );

        // Activate subscription
        await db.promise().query(
          `UPDATE subscriptions 
           SET status = 'active', 
               start_date = CURDATE(), 
               end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), 
               mpesa_receipt = ?
           WHERE user_id = ? 
             AND status = 'pending' 
           ORDER BY id DESC 
           LIMIT 1`,
          [receipt, userId]
        );

        // Update user
        await db.promise().query(
          `UPDATE users 
           SET subscription = 'pro', 
               subscription_status = 'active', 
               subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH),
               mpesa_receipt = ?,
               payment_date = NOW()
           WHERE id = ?`,
          [receipt, userId]
        );
      }
    }

    res.json({
      success: true,
      status: result.ResultCode === '0' ? 'success' : 'pending',
      result_code: result.ResultCode,
      result_desc: result.ResultDesc,
      checkout_request_id: checkout_request_id,
      raw_response: result
    });

  } catch (error) {
    console.error('STK Query error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

// ==================== M-PESA CALLBACK (Webhook) ====================
exports.mpesaCallback = async (req, res) => {
  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    const { Body } = req.body;
    const result = Body.stkCallback;
    const checkoutRequestId = result.CheckoutRequestID;

    console.log('Callback received for CheckoutRequestID:', checkoutRequestId);

    if (result.ResultCode === 0) {
      const items = result.CallbackMetadata.Item;
      const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const phone = items.find(i => i.Name === 'PhoneNumber')?.Value;
      const amount = items.find(i => i.Name === 'Amount')?.Value;
      const transactionDate = items.find(i => i.Name === 'TransactionDate')?.Value;

      const [paymentRows] = await connection.query(
        'SELECT user_id, id FROM payments WHERE checkout_request_id = ?',
        [checkoutRequestId]
      );

      if (!paymentRows.length) {
        console.error('No payment found for CheckoutRequestID:', checkoutRequestId);
        await connection.rollback();
        connection.release();
        return res.json({ ResultCode: 0, ResultDesc: 'Received' });
      }

      const userId = paymentRows[0].user_id;
      const paymentId = paymentRows[0].id;

      await connection.query(
        `UPDATE payments 
         SET mpesa_receipt = ?, status = 'success',
             transaction_date = ?
         WHERE checkout_request_id = ? 
           AND user_id = ?`,
        [receipt, transactionDate, checkoutRequestId, userId]
      );

      await connection.query(
        `UPDATE subscriptions 
         SET status = 'active', 
             start_date = CURDATE(), 
             end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), 
             mpesa_receipt = ?
         WHERE user_id = ? 
           AND status = 'pending' 
         ORDER BY id DESC 
         LIMIT 1`,
        [receipt, userId]
      );

      await connection.query(
        `UPDATE users 
         SET subscription = 'pro', 
             subscription_status = 'active', 
             subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH),
             mpesa_receipt = ?,
             payment_date = NOW()
         WHERE id = ?`,
        [receipt, userId]
      );

      await connection.commit();
      console.log(`✅ TRANSACTION COMMITTED for user ${userId}, receipt: ${receipt}`);
    } else {
      console.log('M-Pesa payment failed:', result.ResultDesc);

      await connection.query(
        `UPDATE payments 
         SET mpesa_receipt = 'FAILED', status = 'failed'
         WHERE checkout_request_id = ?`,
        [checkoutRequestId]
      );

      await connection.commit();
    }

    connection.release();
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error('Callback error - TRANSACTION ROLLED BACK:', error);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
  }
};

// ==================== CONFIRM DEMO PAYMENT ====================
exports.confirmDemo = async (req, res) => {
  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    const { subscription_id, firebase_uid } = req.body;

    const userId = await getUserId(firebase_uid);
    if (!userId) {
      connection.release();
      return res.status(404).json({ message: 'User not found' });
    }

    const [paymentRows] = await connection.query(
      `SELECT mpesa_receipt 
       FROM payments 
       WHERE user_id = ? AND mpesa_receipt IS NOT NULL AND mpesa_receipt != 'FAILED'
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId]
    );

    const realReceipt = paymentRows[0]?.mpesa_receipt || 'DEMO_RECEIPT';

    const [subs] = await connection.query(
      'SELECT plan, plan_id FROM subscriptions WHERE id = ? AND user_id = ?',
      [subscription_id, userId]
    );

    const sub = subs[0];
    const planName = sub?.plan || 'pro';

    await connection.query(
      `UPDATE subscriptions 
       SET status = 'active', 
           start_date = CURDATE(), 
           end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), 
           mpesa_receipt = ?
       WHERE id = ? AND user_id = ?`,
      [realReceipt, subscription_id, userId]
    );

    await connection.query(
      `UPDATE users 
       SET subscription = ?, 
           subscription_status = 'active', 
           subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH),
           mpesa_receipt = ?,
           payment_date = NOW()
       WHERE id = ?`,
      [planName, realReceipt, userId]
    );

    await connection.commit();
    connection.release();

    res.json({ 
      message: 'Subscription activated successfully',
      receipt_used: realReceipt
    });
  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error('confirmDemo error - TRANSACTION ROLLED BACK:', error);
    res.status(500).json({ message: error.message });
  }
};

// ==================== CANCEL SUBSCRIPTION ====================
exports.cancelSubscription = async (req, res) => {
  try {
    const { firebase_uid } = req.body;

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    await db.promise().query(
      `UPDATE subscriptions 
       SET status = 'cancelled'
       WHERE user_id = ? 
         AND status = 'active'`,
      [userId]
    );

    res.json({ message: 'Subscription cancelled. You can use Pro features until expiry.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};