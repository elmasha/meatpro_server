const db = require('../config/db');
const axios = require('axios');

// Helper: Get M-Pesa access token
async function getMpesaToken() {
  const consumerKey = process.env.MP_CONSUMER_KEY_DEV;
  const consumerSecret = process.env.MP_SECRET_KEY_DEV;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  
  const { data } = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

// Helper: Get user_id from firebase_uid
async function getUserId(firebaseUid) {
  const [rows] = await db.promise().query(
    'SELECT id FROM users WHERE firebase_uid = ?', [firebaseUid]
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
// FIXED: Uses COALESCE to handle both plan (varchar) and plan_id
exports.getStatus = async (req, res) => {
  try {
    const firebaseUid = req.query.firebase_uid;
    if (!firebaseUid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebaseUid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    // FIXED: Join on plan name since plan_id may be NULL for old records
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

    // If no subscription record, check users table subscription field
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
    const firebaseUid = req.query.firebase_uid;
    if (!firebaseUid) return res.status(400).json({ message: 'firebase_uid required' });

    const userId = await getUserId(firebaseUid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    const [payments] = await db.promise().query(
      `SELECT id, amount, phone, mpesa_receipt,  created_at 
       FROM payments WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    
    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/subscriptions/initiate
exports.initiatePayment = async (req, res) => {
  try {
    const { firebase_uid, plan_id, phone } = req.body;
    
    if (!firebase_uid || !plan_id || !phone) {
      return res.status(400).json({ message: 'firebase_uid, plan_id, and phone required' });
    }

    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    // Get plan
    const [plans] = await db.promise().query(
      'SELECT * FROM plans WHERE id = ? AND is_active = 1', [plan_id]
    );
    if (!plans.length) return res.status(400).json({ message: 'Invalid plan' });
    
    const plan = plans[0];
    const reference = `MPESA_${Date.now()}_${userId}`;

    // Insert subscription using BOTH plan_id and plan name for compatibility
    const [subResult] = await db.promise().query(
      `INSERT INTO subscriptions (user_id, plan_id, plan, amount, start_date, end_date, status, payment_reference, created_at)
       VALUES (?, ?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 MONTH), 'pending', ?, NOW())`,
      [userId, plan.id, plan.name, plan.price_kes, reference]
    );

    // Insert payment
    await db.promise().query(
      `INSERT INTO payments (user_id, amount, phone, subscription, checkout_request_id, transaction_desc, created_at)
       VALUES (?, ?, ?, ?, ?,  ?, NOW())`,
      [userId, subResult.insertId, plan.price_kes, phone, plan.name, reference, `Subscription: ${plan.display_name}`]
    );

    // === REAL M-PESA STK PUSH (Uncomment for production) ===
    
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const shortcode = process.env.MP_SHORTCODE_DEV;
    const passkey = process.env.MP_PASSKEY_DEV;
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
    
    await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(plan.price_kes),
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: `${process.env.API_URL}/api/subscriptions/callback`,
      AccountReference: `MeatPro_${userId}`,
      TransactionDesc: `MeatPro ${plan.display_name}`
    }, { headers: { Authorization: `Bearer ${token}` }});
    

    res.json({
      message: 'Payment initiated. Check your phone for M-Pesa prompt.',
      subscription_id: subResult.insertId,
      amount: plan.price_kes,
      phone: phone,
      reference: reference,
      demo_mode: true
    });
    
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/subscriptions/callback (M-Pesa webhook)
exports.mpesaCallback = async (req, res) => {
  try {
    const { Body } = req.body;
    const result = Body.stkCallback;
    
    if (result.ResultCode === 0) {
      const items = result.CallbackMetadata.Item;
      const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const phone = items.find(i => i.Name === 'PhoneNumber')?.Value;
      const amount = items.find(i => i.Name === 'Amount')?.Value;
      const ref = items.find(i => i.Name === 'AccountReference')?.Value;
      const userId = parseInt(ref?.split('_')[1]) || 1;

      // Update payment
      await db.promise().query(
        `UPDATE payments SET status = 'success', mpesa_receipt = ? 
         WHERE user_id = ? AND amount = ? AND status = 'pending' 
         ORDER BY id DESC LIMIT 1`,
        [receipt, userId, amount]
      );

      // Activate subscription
      await db.promise().query(
        `UPDATE subscriptions SET status = 'active', start_date = CURDATE(), 
         end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), mpesa_receipt = ? 
         WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
        [receipt, userId]
      );

      // Update user
      await db.promise().query(
        `UPDATE users SET subscription = 'pro', subscription_status = 'active', 
         subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
         WHERE id = ?`,
        [userId]
      );
    }
    
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    res.status(500).json({ ResultCode: 1, ResultDesc: error.message });
  }
};

// POST /api/subscriptions/confirm (Demo/manual confirmation)
exports.confirmDemo = async (req, res) => {
  try {
    const { subscription_id, firebase_uid } = req.body;
    
    const userId = await getUserId(firebase_uid);
    if (!userId) return res.status(404).json({ message: 'User not found' });

    // Get subscription plan
    const [subs] = await db.promise().query(
      'SELECT plan, plan_id FROM subscriptions WHERE id = ? AND user_id = ?',
      [subscription_id, userId]
    );
    
    const sub = subs[0];
    const planName = sub?.plan || 'pro';
    const planId = sub?.plan_id;

    // Activate subscription
    await db.promise().query(
      `UPDATE subscriptions SET status = 'active', start_date = CURDATE(), 
       end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), mpesa_receipt = 'DEMO_RECEIPT' 
       WHERE id = ? AND user_id = ?`,
      [subscription_id, userId]
    );
    
    // Update payment
    await db.promise().query(
      `UPDATE payments SET status = 'success', mpesa_receipt = 'DEMO_RECEIPT' 
       WHERE subscription_id = ?`,
      [subscription_id]
    );

    // Update user
    await db.promise().query(
      `UPDATE users SET subscription = ?, subscription_status = 'active', 
       subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
       WHERE id = ?`,
      [planName, userId]
    );
    
    res.json({ message: 'Subscription activated successfully' });
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
      `UPDATE subscriptions SET status = 'cancelled' 
       WHERE user_id = ? AND status = 'active'`,
      [userId]
    );
    
    res.json({ message: 'Subscription cancelled. You can use Pro features until expiry.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};