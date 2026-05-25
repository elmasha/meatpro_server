const db = require('../config/db');
const axios = require('axios');

// Helper: Get M-Pesa access token
async function getMpesaToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  
  const { data } = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
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

// GET /api/subscriptions/status?business_id=1
exports.getStatus = async (req, res) => {
  try {
    const business_id = parseInt(req.query.business_id);
    if (!business_id) return res.status(400).json({ message: 'business_id required' });

    const [rows] = await db.promise().query(`
      SELECT s.*, p.name as plan_name, p.display_name, p.price_kes, p.features
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.business_id = ?
      ORDER BY s.created_at DESC
      LIMIT 1
    `, [business_id]);

    const subscription = rows[0] || {
      status: 'expired',
      plan_name: 'starter',
      display_name: 'Starter (Free)',
      plan_id: 1,
      expires_at: null,
      features: '["1 branch","Daily operations","Basic profit summary","7-day history"]'
    };

    const isActive = subscription.status === 'active' && 
      subscription.expires_at && new Date(subscription.expires_at) > new Date();

    const daysRemaining = isActive 
      ? Math.ceil((new Date(subscription.expires_at) - new Date()) / (1000 * 60 * 60 * 24))
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

// GET /api/subscriptions/history?business_id=1
exports.getPaymentHistory = async (req, res) => {
  try {
    const business_id = parseInt(req.query.business_id);
    if (!business_id) return res.status(400).json({ message: 'business_id required' });

    const [payments] = await db.promise().query(
      `SELECT id, amount, phone, mpesa_receipt, status, created_at 
       FROM payments WHERE business_id = ? ORDER BY created_at DESC`,
      [business_id]
    );
    
    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/subscriptions/initiate
exports.initiatePayment = async (req, res) => {
  try {
    const { business_id, plan_id, phone } = req.body;
    
    if (!business_id || !plan_id || !phone) {
      return res.status(400).json({ message: 'business_id, plan_id, and phone required' });
    }

    // Get plan
    const [plans] = await db.promise().query(
      'SELECT * FROM plans WHERE id = ? AND is_active = 1', [plan_id]
    );
    if (!plans.length) return res.status(400).json({ message: 'Invalid plan' });
    
    const plan = plans[0];
    const reference = `MPESA_${Date.now()}_${business_id}`;

    // Create pending subscription
    const [subResult] = await db.promise().query(
      `INSERT INTO subscriptions (business_id, plan_id, status, start_date, end_date, payment_reference, created_at)
       VALUES (?, ?, 'pending', CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 MONTH), ?, NOW())`,
      [business_id, plan_id, reference]
    );

    // Log payment
    await db.promise().query(
      `INSERT INTO payments (business_id, subscription_id, amount, phone, status, transaction_desc, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, NOW())`,
      [business_id, subResult.insertId, plan.price_kes, phone, `Subscription: ${plan.display_name}`]
    );

    // === REAL M-PESA STK PUSH (Uncomment for production) ===
    /*
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
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
      AccountReference: `MeatPro_${business_id}`,
      TransactionDesc: `MeatPro ${plan.display_name}`
    }, { headers: { Authorization: `Bearer ${token}` }});
    */

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
      const business_id = parseInt(ref?.split('_')[1]) || 1;

      // Update payment
      await db.promise().query(
        `UPDATE payments SET status = 'success', mpesa_receipt = ? 
         WHERE phone = ? AND amount = ? AND status = 'pending' 
         ORDER BY id DESC LIMIT 1`,
        [receipt, phone, amount]
      );

      // Activate subscription
      await db.promise().query(
        `UPDATE subscriptions SET status = 'active', start_date = CURDATE(), 
         end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), mpesa_receipt = ? 
         WHERE business_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
        [receipt, business_id]
      );

      // Update user/business subscription status
      await db.promise().query(
        `UPDATE users SET subscription_status = 'active', subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
         WHERE business_id = ?`,
        [business_id]
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
    const { subscription_id, business_id } = req.body;
    
    await db.promise().query(
      `UPDATE subscriptions SET status = 'active', start_date = CURDATE(), 
       end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), mpesa_receipt = 'DEMO_RECEIPT' 
       WHERE id = ?`,
      [subscription_id]
    );
    
    await db.promise().query(
      `UPDATE payments SET status = 'success', mpesa_receipt = 'DEMO_RECEIPT' 
       WHERE subscription_id = ?`,
      [subscription_id]
    );

    await db.promise().query(
      `UPDATE users SET subscription_status = 'active', subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
       WHERE business_id = ?`,
      [business_id]
    );
    
    res.json({ message: 'Subscription activated successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/subscriptions/cancel
exports.cancelSubscription = async (req, res) => {
  try {
    const { business_id } = req.body;
    
    await db.promise().query(
      `UPDATE subscriptions SET status = 'cancelled', auto_renew = 0 
       WHERE business_id = ? AND status = 'active'`,
      [business_id]
    );
    
    res.json({ message: 'Subscription cancelled. You can use Pro features until expiry.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};