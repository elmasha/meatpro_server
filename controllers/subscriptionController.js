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

// GET /api/plans
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

// GET /api/subscriptions/status?firebase_uid=xxx
exports.getStatus = async (req, res) => {
  try {
    const firebase_uid = req.query.firebase_uid;
    if (!firebase_uid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [rows] = await db.promise().query(`
      SELECT s.*, 
        COALESCE(p.name, s.plan, 'starter') as plan_name,
        COALESCE(p.display_name, 'Starter (Free)') as display_name,
        COALESCE(p.price_kes, 0) as price_kes,
        COALESCE(p.features, '["1 branch","Daily operations","Basic profit summary","7-day history"]') as features
      FROM subscriptions s
      LEFT JOIN plans p ON COALESCE(s.plan_id, 0) = p.id OR s.plan = p.name
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
        plan_name: userSub?.subscription || 'starter',
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

// GET /api/subscriptions/history?firebase_uid=xxx
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

// GET /api/subscriptions/latest-receipt?firebase_uid=xxx
exports.getLatestReceipt = async (req, res) => {
  try {
    const firebase_uid = req.query.firebase_uid;
    if (!firebase_uid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [rows] = await db.promise().query(
      `SELECT mpesa_receipt, checkout_request_id, amount, created_at 
       FROM payments 
       WHERE user_id = ? AND mpesa_receipt IS NOT NULL 
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

// POST /api/subscriptions/initiate
// UPDATED: Saves M-Pesa CheckoutRequestID from STK push response
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

    // Insert subscription first
    const [subResult] = await db.promise().query(
      `INSERT INTO subscriptions (user_id, plan_id, plan, amount, start_date, end_date, status, payment_reference, created_at)
       VALUES (?, ?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 MONTH), 'pending', ?, NOW())`,
      [userId, plan.id, plan.name, plan.price_kes, reference]
    );

    // Insert payment with our reference as temporary checkout_request_id
    const [paymentResult] = await db.promise().query(
      `INSERT INTO payments (user_id, amount, phone, subscription, checkout_request_id, mpesa_receipt, transaction_date, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NOW())`,
      [userId, plan.price_kes, phone, plan.name, reference]
    );

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const shortcode = process.env.MP_SHORTCODE_DEV;
    const passkey = process.env.MP_PASSKEY_DEV;
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    // Make STK push and capture response
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

    // UPDATED: Save M-Pesa's CheckoutRequestID to payments table
    if (stkResponse.CheckoutRequestID) {
      await db.promise().query(
        `UPDATE payments 
         SET checkout_request_id = ?
         WHERE id = ?`,
        [stkResponse.CheckoutRequestID, paymentResult.insertId]
      );

      console.log(`Updated payment ${paymentResult.insertId} with CheckoutRequestID: ${stkResponse.CheckoutRequestID}`);
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

// POST /api/subscriptions/callback (M-Pesa webhook)
// UPDATED: Now matches by M-Pesa CheckoutRequestID since we saved it
exports.mpesaCallback = async (req, res) => {
  try {
    const { Body } = req.body;
    const result = Body.stkCallback;

    if (result.ResultCode === 0) {
      const items = result.CallbackMetadata.Item;
      const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const ref = items.find(i => i.Name === 'AccountReference')?.Value;
      const checkoutRequestId = result.CheckoutRequestID;


      const [paymentRows] = await db.promise().query(
        'SELECT user_id, id FROM payments WHERE checkout_request_id = ?',
        [checkoutRequestId]  // ← M-Pesa sends this back, we match exactly
      );
      const userId = paymentRows[0].user_id;  // ← Correct user (5, not 1)

      console.log('Callback received:', { receipt, checkoutRequestId, userId });

      // UPDATED: Match by M-Pesa's CheckoutRequestID
      const [updateResult] = await db.promise().query(
        `UPDATE payments 
         SET mpesa_receipt = ?
         WHERE checkout_request_id = ? 
           AND user_id = ?`,
        [receipt, checkoutRequestId, userId]
      );

      console.log(`Payment update result: ${updateResult.affectedRows} rows affected`);

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
             subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
         WHERE id = ?`,
        [userId]
      );
    } else {
      // Payment failed - log it
      console.log('M-Pesa payment failed:', result.ResultDesc);

      // Optionally update payment record to mark as failed
      const checkoutRequestId = result.CheckoutRequestID;
      if (checkoutRequestId) {
        await db.promise().query(
          `UPDATE payments 
           SET mpesa_receipt = 'FAILED'
           WHERE checkout_request_id = ?`,
          [checkoutRequestId]
        );
      }
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('Callback error:', error);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
  }
};

// POST /api/subscriptions/confirm (Demo/manual confirmation)
exports.confirmDemo = async (req, res) => {
  try {
    const { subscription_id, firebase_uid } = req.body;

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    // Get the REAL receipt from the latest payment record
    const [paymentRows] = await db.promise().query(
      `SELECT mpesa_receipt 
       FROM payments 
       WHERE user_id = ? AND mpesa_receipt IS NOT NULL AND mpesa_receipt != 'FAILED'
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId]
    );

    const realReceipt = paymentRows[0]?.mpesa_receipt || 'DEMO_RECEIPT';

    const [subs] = await db.promise().query(
      'SELECT plan, plan_id FROM subscriptions WHERE id = ? AND user_id = ?',
      [subscription_id, userId]
    );

    const sub = subs[0];
    const planName = sub?.plan || 'pro';

    // Activate subscription with REAL receipt
    await db.promise().query(
      `UPDATE subscriptions 
       SET status = 'active', 
           start_date = CURDATE(), 
           end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), 
           mpesa_receipt = ?
       WHERE id = ? AND user_id = ?`,
      [realReceipt, subscription_id, userId]
    );

    // Update user
    await db.promise().query(
      `UPDATE users 
       SET subscription = ?, 
           subscription_status = 'active', 
           subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
       WHERE id = ?`,
      [planName, userId]
    );

    res.json({ 
      message: 'Subscription activated successfully',
      receipt_used: realReceipt
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/subscriptions/cancel
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