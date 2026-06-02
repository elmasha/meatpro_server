const db = require('../config/db');

// ==================== SIMPLE ADMIN MIDDLEWARE ====================
// Accept uid from query param OR header
// exports.requireAdmin = async (req, res, next) => {
//   try {
//     // Try query param first, then header
//     const firebaseUid = req.query.uid || req.headers['x-firebase-uid'];
    
//     if (!firebaseUid) {
//       return res.status(401).json({ error: 'Authentication required. Provide uid parameter or x-firebase-uid header' });
//     }

//     const [users] = await db.promise().query(
//       'SELECT id, user_type, name FROM users WHERE firebase_uid = ? LIMIT 1',
//       [firebaseUid]
//     );

//     if (!users.length) {
//       return res.status(401).json({ error: 'User not found' });
//     }

//     if (users[0].user_type !== 'Admin') {
//       return res.status(403).json({ error: 'Admin access required' });
//     }

//     req.adminUser = users[0];
//     req.firebaseUid = firebaseUid; // Store for later use
//     next();
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

// ==================== DASHBOARD STATS ====================
exports.getDashboardStats = async (req, res) => {
  try {
    const connection = await db.promise().getConnection();

    const [[usersCount]] = await connection.query('SELECT COUNT(*) as total FROM users');
    const [[businessCount]] = await connection.query('SELECT COUNT(*) as total FROM businesses');
    const [[branchesCount]] = await connection.query('SELECT COUNT(*) as total FROM branches');
    const [[activeSubs]] = await connection.query(
      "SELECT COUNT(*) as total FROM subscriptions WHERE status = 'active'"
    );
    const [[monthlyRevenue]] = await connection.query(
      `SELECT COALESCE(SUM(amount), 0) as total 
       FROM payments 
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       AND mpesa_receipt IS NOT NULL`
    );
    const [[pendingSubs]] = await connection.query(
      "SELECT COUNT(*) as total FROM subscriptions WHERE status = 'pending'"
    );
    const [[expiredSubs]] = await connection.query(
      "SELECT COUNT(*) as total FROM subscriptions WHERE status = 'expired'"
    );
    const [[todaysEntries]] = await connection.query(
      "SELECT COUNT(*) as total FROM daily_entries WHERE date = CURDATE()"
    );

    connection.release();

    res.json({
      success: true,
      data: {
        totalUsers: usersCount.total,
        totalBusinesses: businessCount.total,
        totalBranches: branchesCount.total,
        activeSubscriptions: activeSubs.total,
        monthlyRevenue: monthlyRevenue.total,
        pendingApprovals: pendingSubs.total,
        expiredSubscriptions: expiredSubs.total,
        todaysEntries: todaysEntries.total
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ==================== PLANS ====================
exports.getAllPlans = async (req, res) => {
  try {
    const [plans] = await db.promise().query(
      'SELECT * FROM plans ORDER BY price_kes ASC'
    );
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createPlan = async (req, res) => {
  const { name, display_name, price_kes, billing_cycle, description, features } = req.body;

  try {
    if (!name || !display_name || price_kes === undefined) {
      return res.status(400).json({ error: 'Name, display name and price are required' });
    }

    const featuresJson = Array.isArray(features) ? JSON.stringify(features) : features;

    const [result] = await db.promise().query(
      `INSERT INTO plans (name, display_name, price_kes, billing_cycle, description, features, is_active) 
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [name, display_name, price_kes, billing_cycle || 'monthly', description || null, featuresJson]
    );

    res.status(201).json({
      success: true,
      message: 'Plan created successfully',
      data: { id: result.insertId, name, display_name, price_kes }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Plan name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
};

exports.updatePlan = async (req, res) => {
  const { id } = req.params;
  const { display_name, price_kes, billing_cycle, description, features, is_active } = req.body;

  try {
    const updates = [];
    const values = [];

    if (display_name !== undefined) { updates.push('display_name = ?'); values.push(display_name); }
    if (price_kes !== undefined) { updates.push('price_kes = ?'); values.push(price_kes); }
    if (billing_cycle !== undefined) { updates.push('billing_cycle = ?'); values.push(billing_cycle); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (features !== undefined) {
      updates.push('features = ?');
      values.push(Array.isArray(features) ? JSON.stringify(features) : features);
    }
    if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const [result] = await db.promise().query(
      `UPDATE plans SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    res.json({ success: true, message: 'Plan updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.togglePlanStatus = async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;

  try {
    const [result] = await db.promise().query(
      'UPDATE plans SET is_active = ? WHERE id = ?',
      [active ? 1 : 0, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const status = active ? 'activated' : 'deactivated';
    res.json({ success: true, message: `Plan ${status} successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deletePlan = async (req, res) => {
  const { id } = req.params;

  try {
    const [subs] = await db.promise().query(
      'SELECT COUNT(*) as count FROM subscriptions WHERE plan_id = ? AND status = "active"',
      [id]
    );

    if (subs[0].count > 0) {
      return res.status(400).json({
        error: 'Cannot delete plan with active subscriptions. Deactivate it instead.'
      });
    }

    const [result] = await db.promise().query('DELETE FROM plans WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    res.json({ success: true, message: 'Plan deleted permanently' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ==================== USERS ====================
exports.getAllUsers = async (req, res) => {
  try {
    const [users] = await db.promise().query(`
      SELECT 
        u.*, 
        b.name as business_name, 
        p.display_name as plan_name,
        DATEDIFF(u.subscription_expires, CURDATE()) as days_left
      FROM users u
      LEFT JOIN businesses b ON u.business_id = b.id
      LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
      LEFT JOIN plans p ON s.plan_id = p.id
      ORDER BY u.created_at DESC
    `);

    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, phone, user_type, subscription, subscription_status, subscription_expires } = req.body;

  try {
    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
    if (user_type !== undefined) { updates.push('user_type = ?'); values.push(user_type); }
    if (subscription !== undefined) { updates.push('subscription = ?'); values.push(subscription); }
    if (subscription_status !== undefined) { updates.push('subscription_status = ?'); values.push(subscription_status); }
    if (subscription_expires !== undefined) { updates.push('subscription_expires = ?'); values.push(subscription_expires); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const [result] = await db.promise().query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateUserSubscription = async (req, res) => {
  const { id } = req.params;
  const { plan_id, subscription_status, months = 1 } = req.body;

  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    if (plan_id && subscription_status === 'active') {
      // Expire old
      await connection.query(
        'UPDATE subscriptions SET status = "expired" WHERE user_id = ? AND status = "active"',
        [id]
      );

      // Get plan
      const [plans] = await connection.query('SELECT * FROM plans WHERE id = ?', [plan_id]);
      if (plans.length) {
        const plan = plans[0];
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + parseInt(months));

        await connection.query(
          `INSERT INTO subscriptions 
           (user_id, plan_id, plan, amount, start_date, end_date, status, auto_renew)
           VALUES (?, ?, ?, ?, CURDATE(), ?, 'active', 1)`,
          [id, plan_id, plan.name, plan.price_kes, endDate.toISOString().split('T')[0]]
        );

        await connection.query(
          `UPDATE users 
           SET subscription = ?, subscription_status = 'active', subscription_expires = ?
           WHERE id = ?`,
          [plan.name, endDate.toISOString().split('T')[0], id]
        );
      }
    } else {
      await connection.query(
        'UPDATE users SET subscription_status = ? WHERE id = ?',
        [subscription_status, id]
      );
    }

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'User subscription updated' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ error: err.message });
  }
};

// ==================== PAYMENTS ====================
exports.getAllPayments = async (req, res) => {
  try {
    const [payments] = await db.promise().query(`
      SELECT 
        p.*, 
        u.name as user_name, 
        u.phone as user_phone,
        pl.display_name as plan_name
      FROM payments p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN plans pl ON p.subscription = pl.name
      ORDER BY p.created_at DESC
      LIMIT 200
    `);

    res.json({ success: true, data: payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.confirmPaymentManually = async (req, res) => {
  const { payment_id } = req.body;
  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    const [payments] = await connection.query(
      'SELECT * FROM payments WHERE id = ?',
      [payment_id]
    );

    if (!payments.length) {
      connection.release();
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = payments[0];
    const receipt = 'ADMIN_' + Date.now();

    await connection.query(
      'UPDATE payments SET mpesa_receipt = ?, transaction_date = NOW() WHERE id = ?',
      [receipt, payment_id]
    );

    await connection.query(
      `UPDATE subscriptions 
       SET status = 'active', start_date = CURDATE(), end_date = DATE_ADD(CURDATE(), INTERVAL 1 MONTH), mpesa_receipt = ?
       WHERE user_id = ? AND status = 'pending'
       ORDER BY id DESC LIMIT 1`,
      [receipt, payment.user_id]
    );

    await connection.query(
      `UPDATE users 
       SET subscription = ?, subscription_status = 'active', 
           subscription_expires = DATE_ADD(CURDATE(), INTERVAL 1 MONTH),
           mpesa_receipt = ?, payment_date = NOW()
       WHERE id = ?`,
      [payment.subscription, receipt, payment.user_id]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Payment confirmed manually', receipt });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ error: err.message });
  }
};

// ==================== REVENUE ====================
exports.getRevenueReport = async (req, res) => {
  const { start_date, end_date, group_by = 'day' } = req.query;

  try {
    let groupFormat;
    switch (group_by) {
      case 'month': groupFormat = 'DATE_FORMAT(created_at, "%Y-%m")'; break;
      case 'year': groupFormat = 'YEAR(created_at)'; break;
      default: groupFormat = 'DATE(created_at)';
    }

    const [revenue] = await db.promise().query(`
      SELECT 
        ${groupFormat} as period,
        COUNT(*) as transaction_count,
        COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) as confirmed_revenue,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_revenue
      FROM payments
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY period
      ORDER BY period DESC
    `, [start_date || '2024-01-01', end_date || '2030-12-31']);

    const [[summary]] = await db.promise().query(`
      SELECT 
        COALESCE(SUM(amount), 0) as total_all_time,
        COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN amount ELSE 0 END), 0) as last_30_days,
        COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN amount ELSE 0 END), 0) as last_7_days,
        COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN amount ELSE 0 END), 0) as today,
        COUNT(DISTINCT user_id) as paying_customers
      FROM payments
      WHERE status = 'success'
    `);

    const [byPlan] = await db.promise().query(`
      SELECT 
        p.display_name as plan_name,
        COUNT(*) as sales_count,
        COALESCE(SUM(py.amount), 0) as revenue
      FROM payments py
      LEFT JOIN plans p ON py.subscription = p.name
      WHERE py.status = 'success'
      AND py.created_at >= ? AND py.created_at <= ?
      GROUP BY py.subscription
      ORDER BY revenue DESC
    `, [start_date || '2024-01-01', end_date || '2030-12-31']);

    const [[monthlyRevenue]] = await db.promise().query(
      `SELECT COALESCE(SUM(amount), 0) as total 
      FROM payments 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      AND status = 'success'`
    );

    res.json({
      success: true,
      data: {
        timeline: revenue,
        summary: summary,
        by_plan: byPlan,
        monthly_revenue: monthlyRevenue.total
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ==================== SUBSCRIPTIONS ====================
exports.getActiveSubscriptions = async (req, res) => {
  const { status = 'active', plan_id, search } = req.query;

  try {
    let whereClause = 'WHERE 1=1';
    let params = [];

    if (status !== 'all') {
      whereClause += ' AND s.status = ?';
      params.push(status);
    }
    if (plan_id) {
      whereClause += ' AND s.plan_id = ?';
      params.push(plan_id);
    }
    if (search) {
      whereClause += ' AND (u.name LIKE ? OR u.phone LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like);
    }

    const [subscriptions] = await db.promise().query(`
      SELECT 
        s.*,
        u.name as user_name,
        u.phone as user_phone,
        u.firebase_uid,
        p.display_name as plan_name,
        p.price_kes as plan_price,
        DATEDIFF(s.end_date, CURDATE()) as days_remaining,
        CASE 
          WHEN DATEDIFF(s.end_date, CURDATE()) <= 3 THEN 'critical'
          WHEN DATEDIFF(s.end_date, CURDATE()) <= 7 THEN 'warning'
          ELSE 'healthy'
        END as expiry_status
      FROM subscriptions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN plans p ON s.plan_id = p.id
      ${whereClause}
      ORDER BY s.end_date ASC
    `, params);

    res.json({ success: true, data: subscriptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.renewSubscription = async (req, res) => {
  const { id } = req.params;
  const { months = 1 } = req.body;

  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    const [subs] = await connection.query('SELECT * FROM subscriptions WHERE id = ?', [id]);

    if (!subs.length) {
      connection.release();
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const sub = subs[0];
    const newEndDate = new Date(sub.end_date);
    newEndDate.setMonth(newEndDate.getMonth() + parseInt(months));

    await connection.query(
      `UPDATE subscriptions 
       SET end_date = ?, status = 'active', auto_renew = 1
       WHERE id = ?`,
      [newEndDate.toISOString().split('T')[0], id]
    );

    await connection.query(
      `UPDATE users 
       SET subscription_status = 'active', subscription_expires = ?
       WHERE id = ?`,
      [newEndDate.toISOString().split('T')[0], sub.user_id]
    );

    await connection.commit();
    connection.release();

    res.json({
      success: true,
      message: `Renewed for ${months} month(s)`,
      new_end_date: newEndDate.toISOString().split('T')[0]
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ error: err.message });
  }
};

exports.cancelSubscription = async (req, res) => {
  const { id } = req.params;

  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    const [subs] = await connection.query('SELECT * FROM subscriptions WHERE id = ?', [id]);

    if (!subs.length) {
      connection.release();
      return res.status(404).json({ error: 'Subscription not found' });
    }

    await connection.query(
      'UPDATE subscriptions SET status = "cancelled", auto_renew = 0 WHERE id = ?',
      [id]
    );

    await connection.query(
      `UPDATE users 
       SET subscription_status = 'cancelled', subscription = NULL
       WHERE id = ?`,
      [subs[0].user_id]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Subscription cancelled' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ error: err.message });
  }
};

exports.extendSubscription = async (req, res) => {
  const { id } = req.params;
  const { days } = req.body;

  try {
    const [subs] = await db.promise().query('SELECT * FROM subscriptions WHERE id = ?', [id]);

    if (!subs.length) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    await db.promise().query(
      `UPDATE subscriptions 
       SET end_date = DATE_ADD(end_date, INTERVAL ? DAY)
       WHERE id = ?`,
      [days, id]
    );

    res.json({ success: true, message: `Extended by ${days} days` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ==================== BUSINESSES ====================
exports.getAllBusinesses = async (req, res) => {
  try {
    const [businesses] = await db.promise().query(`
      SELECT 
        b.*, 
        u.name as owner_name, 
        u.phone as owner_phone,
        (SELECT COUNT(*) FROM branches WHERE business_id = b.id) as branch_count
      FROM businesses b
      LEFT JOIN users u ON b.firebase_uid = u.firebase_uid
      ORDER BY b.created_at DESC
    `);

    res.json({ success: true, data: businesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getBusinessBranches = async (req, res) => {
  const { business_id } = req.params;

  try {
    const [branches] = await db.promise().query(
      'SELECT * FROM branches WHERE business_id = ?',
      [business_id]
    );

    res.json({ success: true, data: branches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};