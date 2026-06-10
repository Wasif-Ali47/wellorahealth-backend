import express from 'express';
import { body, validationResult } from 'express-validator';
import * as authController from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { checkUserExistsByEmail } from '../middleware/checkUserExistsByEmail.js';

const router = express.Router();

function validateAuthRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.error('[auth] Validation failed:', JSON.stringify(errors.array()));
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array(),
    });
  }
  next();
}

const signUpValidators = [
  body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('name').trim().optional(),
  body('firstName').trim().optional(),
  body('lastName').trim().optional(),
  body().custom((_, { req }) => {
    const name = req.body?.name?.trim()
      || [req.body?.firstName, req.body?.lastName].filter(Boolean).join(' ').trim();
    if (!name) throw new Error('name required');
    return true;
  }),
];

// OTP sign-up (sample_backend) — returns userId, no token
router.post(
  '/signup',
  signUpValidators,
  validateAuthRequest,
  checkUserExistsByEmail,
  authController.signUp
);

// Legacy alias
router.post(
  '/register',
  signUpValidators,
  validateAuthRequest,
  checkUserExistsByEmail,
  authController.register
);

router.post('/verify-otp', authController.verifyOtp);

router.post('/resend-otp', authController.resendOtp);

router.post(
  '/forgot-password',
  body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
  validateAuthRequest,
  authController.forgotPassword
);

router.post(
  '/forgotPassword',
  body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
  validateAuthRequest,
  authController.forgotPassword
);

router.post(
  '/reset-password',
  [
    body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
    body('otp').matches(/^\d{6}$/).withMessage('Enter the 6-digit code'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  validateAuthRequest,
  authController.resetPassword
);

router.post(
  '/resetPassword',
  [
    body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
    body('otp').matches(/^\d{6}$/).withMessage('Enter the 6-digit code'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  validateAuthRequest,
  authController.resetPassword
);

// Login user
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], authController.login);

// Google Sign-In (ID token from Flutter)
router.post('/google', authController.googleSignIn);

// Guest login
router.post('/guest', authController.guestLogin);

// Guest → full account (same Mongo user, new email + password)
router.post('/upgrade-guest', authenticate, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').trim().notEmpty(),
  body('lastName').trim().optional(),
], authController.upgradeGuest);

// Verify token
router.get('/verify', authController.verifyToken);

export default router;
