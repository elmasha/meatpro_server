const express = require('express');
const router = express.Router();
const businessController = require('../controllers/businessController');

// ── Users ──
router.post('/users/sync', businessController.syncFirebaseUser);
router.get('/users/me/role', businessController.getMyRole);
router.get('/users/:firebase_uid/profile', businessController.getUserProfile);

// ── Businesses ──
router.post('/businesses', businessController.createBusiness);
router.get('/businesses/my', businessController.getMyBusiness);
router.put('/businesses/my', businessController.updateMyBusiness);
router.get('/businesses', businessController.getAllBusinesses);   // admin only

// ── Branches ──
router.post('/branches', businessController.createBranch);
router.get('/branches/my', businessController.getMyBranches);
router.get('/branches/business/:business_id', businessController.getBranchesByBusiness);
router.put('/branches/:id', businessController.updateBranch);
router.delete('/branches/:id', businessController.deleteBranch);

module.exports = router;