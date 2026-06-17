import User from '../models/User.js';
import { generateToken, JWT_SECRET } from '../middleware/auth.js';
import { validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { sendEmail, sendOTPEmail } from '../services/emailService.js';
import { AUTH_MESSAGES } from '../utils/authMessages.js';

const googleOAuthClient = process.env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
  : null;

console.error('[auth] authController loaded — OTP email signup ENABLED');

function resolveDisplayName(body) {
  if (body.name?.trim()) return body.name.trim();
  const first = body.firstName?.trim() || '';
  const last = body.lastName?.trim() || '';
  const combined = `${first} ${last}`.trim();
  return combined || null;
}

function splitNameToFirstLast(displayName) {
  if (!displayName) return { firstName: undefined, lastName: undefined };
  const parts = displayName.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: undefined, lastName: undefined };
  if (parts.length === 1) return { firstName: parts[0], lastName: undefined };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

function normalizeGoogleProfileImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isValidOtp(value) {
  return /^\d{6}$/.test(String(value || '').trim());
}

/**
 * Sign up with OTP email (sample_backend flow) — no JWT until verify-otp + login.
 */
export const signUp = async (req, res) => {
  try {
    const body = req.body;
    console.error('[auth][signup] ========== POST /signup ==========');

    if (!body) {
      console.log('[auth][signup] FAILED: empty body');
      return res.status(400).json({ error: AUTH_MESSAGES.ALL_FIELDS_REQUIRED });
    }

    const displayName = resolveDisplayName(body);
    if (!displayName) {
      console.log('[auth][signup] FAILED: name required');
      return res.status(400).json({ error: AUTH_MESSAGES.NAME_REQUIRED });
    }
    if (!body.email?.trim()) {
      console.log('[auth][signup] FAILED: email required');
      return res.status(400).json({ error: AUTH_MESSAGES.EMAIL_REQUIRED });
    }
    if (!body.password) {
      console.log('[auth][signup] FAILED: password required');
      return res.status(400).json({ error: AUTH_MESSAGES.PASSWORD_REQUIRED });
    }

    const email = (body.email || '').trim().toLowerCase();
    const { firstName, lastName } = splitNameToFirstLast(displayName);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    console.log(`[auth][signup] Creating user email=${email} name=${displayName} otp=${otp}`);

    const user = new User({
      email,
      password: body.password,
      firstName,
      lastName,
      otp,
      emailVerified: false,
    });

    await user.save();
    console.log(`[auth][signup] User saved id=${user._id}`);

    console.log(`[auth][signup] Calling sendOTPEmail for ${email}...`);
    try {
      await sendOTPEmail(email, otp);
      console.log(`[auth][signup] ✅ sendOTPEmail completed for ${email}`);
    } catch (mailErr) {
      console.error('[auth][signup] ❌ OTP send failed, rolling back user:', mailErr?.message || mailErr);
      await User.findByIdAndDelete(user._id);
      return res.status(500).json({
        error: AUTH_MESSAGES.OTP_SEND_FAILED,
        detail: mailErr?.message || 'SMTP error',
      });
    }

    console.log(`[auth][signup] SUCCESS userId=${user._id}`);
    res.status(201).json({
      message: 'User created. OTP sent to email.',
      userId: user._id.toString(),
      success: AUTH_MESSAGES.SIGNED_UP,
    });
  } catch (err) {
    console.error('[auth][signup] FAILED:', err?.message || err);
    if (err?.code === 11000) {
      return res.status(409).json({ error: AUTH_MESSAGES.USER_EXISTS });
    }
    res.status(500).json({ error: AUTH_MESSAGES.SIGN_UP_FAILED });
  }
};

/** Alias for legacy `/register` clients — same OTP signup, no token. */
export const register = signUp;

/**
 * Verify email OTP — `POST /api/auth/verify-otp`
 */
export const verifyOtp = async (req, res) => {
  try {
    const { userId, otp } = req.body;
    console.log(`[auth][verify-otp] userId=${userId}`);

    if (
      userId == null ||
      otp === undefined ||
      otp === null ||
      String(otp).trim() === ''
    ) {
      console.log('[auth][verify-otp] FAILED: missing userId or otp');
      return res.status(400).json({ error: AUTH_MESSAGES.USER_ID_OTP_REQUIRED });
    }

    const user = await User.findById(userId);
    if (!user) {
      console.log('[auth][verify-otp] FAILED: user not found');
      return res.status(400).json({ error: AUTH_MESSAGES.USER_NOT_FOUND });
    }

    if (user.otp !== String(otp).trim()) {
      console.log(`[auth][verify-otp] FAILED: invalid otp for ${user.email}`);
      return res.status(400).json({ error: AUTH_MESSAGES.INVALID_OTP });
    }

    user.emailVerified = true;
    user.otp = null;
    await user.save();

    console.log(`[auth][verify-otp] SUCCESS email=${user.email}`);
    res.json({ message: 'Email verified successfully.' });
  } catch (err) {
    console.error('[auth][verify-otp] FAILED:', err?.message || err);
    res.status(500).json({ error: AUTH_MESSAGES.NETWORK_ERROR });
  }
};

/**
 * Resend verification OTP — body: `userId` OR (`email` + `password` for login flow).
 */
export const resendOtp = async (req, res) => {
  try {
    const { userId, email, password } = req.body;
    console.log('[auth][resend-otp] request received', {
      hasUserId: !!userId,
      email: email?.trim() || null,
    });

    let user = null;
    if (email?.trim()) {
      const normalizedEmail = email.trim().toLowerCase();
      user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        console.log('[auth][resend-otp] FAILED: user not found for email');
        return res.status(400).json({ error: AUTH_MESSAGES.USER_NOT_FOUND });
      }
      if (!password) {
        console.log('[auth][resend-otp] FAILED: password required with email');
        return res.status(400).json({ error: AUTH_MESSAGES.PASSWORD_REQUIRED });
      }
      const ok = await user.comparePassword(password);
      if (!ok) {
        console.log('[auth][resend-otp] FAILED: wrong password');
        return res.status(400).json({ error: AUTH_MESSAGES.WRONG_PASSWORD });
      }
    } else if (userId) {
      user = await User.findById(userId);
    } else {
      console.log('[auth][resend-otp] FAILED: userId or email required');
      return res.status(400).json({ error: 'userId or email is required' });
    }

    if (!user) {
      console.log('[auth][resend-otp] FAILED: user not found');
      return res.status(400).json({ error: AUTH_MESSAGES.USER_NOT_FOUND });
    }

    if (user.emailVerified === true) {
      console.log(`[auth][resend-otp] FAILED: already verified ${user.email}`);
      return res.status(400).json({ error: 'Email is already verified.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.emailVerified = false;
    await user.save();
    console.log(`[auth][resend-otp] New OTP saved for ${user.email} otp=${otp}`);

    console.log(`[auth][resend-otp] Calling sendOTPEmail for ${user.email}...`);
    try {
      await sendOTPEmail(user.email, otp);
      console.log(`[auth][resend-otp] ✅ sendOTPEmail completed for ${user.email}`);
    } catch (mailErr) {
      console.error('[auth][resend-otp] ❌ OTP send failed:', mailErr?.message || mailErr);
      return res.json({
        message: 'OTP generated. Email delivery is temporarily unavailable.',
        userId: user._id.toString(),
        emailSent: false,
      });
    }

    res.json({
      message: 'OTP sent successfully.',
      userId: user._id.toString(),
      emailSent: true,
    });
  } catch (err) {
    console.error('[auth][resend-otp] FAILED:', err?.message || err);
    res.status(500).json({ error: AUTH_MESSAGES.NETWORK_ERROR });
  }
};

/**
 * Start password reset - body: { email }
 * Sends a 6-digit reset code to the user's email.
 */
export const forgotPassword = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: AUTH_MESSAGES.EMAIL_REQUIRED });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: AUTH_MESSAGES.USER_NOT_FOUND });
    }

    if (user.active === false || user.isBanned === true) {
      return res.status(403).json({
        error: 'This account cannot reset password. Please contact support.',
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetOTP = otp;
    await user.save();

    await sendEmail(
      email,
      'Wellora Health - Reset Password Code',
      `Your password reset code is: ${otp}\n\nEnter this 6-digit code in the app to choose a new password. If you did not request this, ignore this email.`
    );

    res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    console.error('[auth][forgot-password] FAILED:', err?.message || err);
    res.status(500).json({ error: AUTH_MESSAGES.NETWORK_ERROR });
  }
};

/**
 * Complete password reset - body: { email, otp, newPassword }
 */
export const resetPassword = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: AUTH_MESSAGES.ALL_FIELDS_REQUIRED });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!isValidOtp(otp)) {
      return res.status(400).json({ error: 'Invalid OTP format' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters',
      });
    }

    const user = await User.findOne({ email, resetOTP: otp });
    if (!user) {
      return res.status(400).json({ error: AUTH_MESSAGES.INVALID_OTP });
    }

    user.password = newPassword;
    user.resetOTP = null;
    user.emailVerified = true;
    await user.save();

    res.json({ success: true, message: 'Password reset successful' });
  } catch (err) {
    console.error('[auth][reset-password] FAILED:', err?.message || err);
    res.status(500).json({ error: AUTH_MESSAGES.NETWORK_ERROR });
  }
};

/**
 * Login user
 */
export const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(400).json({ error: AUTH_MESSAGES.USER_NOT_FOUND });
    }

    // Check password
    if (!user.password) {
      return res.status(400).json({
        error: 'No password set for this account. Please register with a password.',
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ error: AUTH_MESSAGES.WRONG_PASSWORD });
    }

    if (user.emailVerified !== true) {
      console.log(`[auth][login] BLOCKED unverified email=${normalizedEmail} userId=${user._id}`);
      return res.status(400).json({
        error: AUTH_MESSAGES.EMAIL_NOT_VERIFIED,
        userId: user._id.toString(),
      });
    }

    const token = generateToken(user._id);
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();

    res.json({
      success: true,
      successMessage: AUTH_MESSAGES.LOGGED_IN,
      message: 'Login successful',
      token,
      userId: user._id,
      username: displayName || user.firstName || 'User',
      useremail: user.email,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerified: user.emailVerified,
        onboardingComplete: user.onboardingComplete,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message
    });
  }
};

/**
 * Sign in / register with Google ID token (Flutter google_sign_in).
 * POST /api/auth/google  { idToken }
 */
export const googleSignIn = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'idToken required' });
    }
    if (!googleOAuthClient) {
      console.error('[auth][google] GOOGLE_CLIENT_ID not set in .env');
      return res.status(500).json({ error: AUTH_MESSAGES.GOOGLE_NOT_CONFIGURED });
    }

    let payload;
    try {
      const ticket = await googleOAuthClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyErr) {
      console.error('[auth][google] Token verify failed:', verifyErr?.message || verifyErr);
      return res.status(401).json({ error: AUTH_MESSAGES.GOOGLE_TOKEN_INVALID });
    }

    const googleId = payload.sub;
    const email = (payload.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: AUTH_MESSAGES.GOOGLE_NO_EMAIL });
    }

    const { firstName, lastName } = splitNameToFirstLast(
      payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(' ')
    );
    const googleProfileImageUrl = normalizeGoogleProfileImageUrl(payload.picture)
      || normalizeGoogleProfileImageUrl(req.body?.photoUrl);

    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (!user) {
      user = new User({
        email,
        googleId,
        firstName: firstName || payload.given_name || 'User',
        lastName: lastName || payload.family_name,
        profileImageUrl: googleProfileImageUrl,
        emailVerified: true,
        onboardingComplete: false,
      });
      await user.save();
      console.log(`[auth][google] New user id=${user._id} email=${email}`);
    } else {
      if (!user.googleId) {
        user.googleId = googleId;
      }
      if (user.emailVerified !== true) {
        user.emailVerified = true;
      }
      if (!user.firstName && (firstName || payload.given_name)) {
        user.firstName = firstName || payload.given_name;
      }
      if (!user.lastName && (lastName || payload.family_name)) {
        user.lastName = lastName || payload.family_name;
      }
      if (!user.profileImageUrl && googleProfileImageUrl) {
        user.profileImageUrl = googleProfileImageUrl;
      }
      await user.save();
      console.log(`[auth][google] Existing user id=${user._id} email=${email}`);
    }

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Google sign-in successful',
      successMessage: AUTH_MESSAGES.LOGGED_IN,
      token,
      user: {
        id: user._id.toString(),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
        subscriptionPlan: user.subscriptionPlan,
        isPro: user.isPro === true,
        emailVerified: user.emailVerified,
        onboardingComplete: user.onboardingComplete,
      },
    });
  } catch (error) {
    console.error('[auth][google] error:', error);
    if (error?.code === 11000) {
      return res.status(409).json({ error: AUTH_MESSAGES.USER_EXISTS });
    }
    res.status(500).json({
      success: false,
      message: 'Google sign-in failed',
      error: error.message,
    });
  }
};

/**
 * Guest login
 */
export const guestLogin = async (req, res) => {
  try {
    const { deviceId } = req.body;
    const guestEmail = `guest_${deviceId || Date.now()}@wellorahealth.app`;

    let user = await User.findOne({ email: guestEmail });
    
    if (!user) {
      user = new User({
        email: guestEmail,
        firstName: 'Guest',
        onboardingComplete: false
      });
      await user.save();
    }

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Guest session created',
      token,
      user: {
        id: user._id.toString(),
        email: user.email,
        firstName: user.firstName,
        emailVerified: user.emailVerified,
        onboardingComplete: user.onboardingComplete
      }
    });
  } catch (error) {
    console.error('Guest login error:', error);
    res.status(500).json({
      success: false,
      message: 'Guest login failed',
      error: error.message
    });
  }
};

/**
 * Verify token
 */
/**
 * Upgrade a guest account to a full email/password account (same user id).
 * Requires Bearer token for the guest user.
 */
export const upgradeGuest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const userId = req.userId;
    const { email, password, firstName, lastName } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const em = (user.email || '').toLowerCase();
    const isGuest = /^guest_[^@]+@wellorahealth\.app$/i.test(em);
    const isPendingEmailVerification = user.emailVerified === false;
    if (!isGuest && !isPendingEmailVerification) {
      return res.status(400).json({
        success: false,
        message: 'This account is already a full account. Use profile settings to change your email.'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail, _id: { $ne: userId } });
    if (existing) {
      return res.status(409).json({
        error: AUTH_MESSAGES.USER_EXISTS,
        message: 'An account with this email already exists. Sign in instead.',
      });
    }

    const previousEmail = user.email;
    const previousPassword = user.password;
    const previousFirstName = user.firstName;
    const previousLastName = user.lastName;
    const previousEmailVerified = user.emailVerified;
    const previousOtp = user.otp;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    user.email = normalizedEmail;
    user.password = password;
    user.firstName = firstName || user.firstName;
    if (lastName !== undefined) user.lastName = lastName;
    user.emailVerified = false;
    user.otp = otp;

    await user.save();

    console.log(`[auth][upgrade-guest] Calling sendOTPEmail to ${normalizedEmail} otp=${otp}`);
    try {
      await sendOTPEmail(normalizedEmail, otp);
      console.log(`[auth][upgrade-guest] ✅ sendOTPEmail completed for ${normalizedEmail}`);
    } catch (mailErr) {
      console.error('[auth][upgrade-guest] ❌ OTP send failed:', mailErr?.message || mailErr);
      user.email = previousEmail;
      user.password = previousPassword;
      user.firstName = previousFirstName;
      user.lastName = previousLastName;
      user.emailVerified = previousEmailVerified;
      user.otp = previousOtp;
      await user.save();
      return res.status(500).json({ error: AUTH_MESSAGES.OTP_SEND_FAILED });
    }

    res.json({
      success: true,
      message: 'OTP sent to email. Verify to complete account setup.',
      userId: user._id,
      user: {
        id: user._id.toString(),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerified: user.emailVerified,
        onboardingComplete: user.onboardingComplete,
      },
    });
  } catch (error) {
    console.error('upgradeGuest error:', error);
    res.status(500).json({
      success: false,
      message: 'Could not upgrade account',
      error: error.message
    });
  }
};

export const verifyToken = async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    const user = await User.findById(decoded.userId).select('-password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.active === false) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated.'
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerified: user.emailVerified,
        onboardingComplete: user.onboardingComplete
      }
    });
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};
