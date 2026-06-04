import User from '../models/User.js';
import { validationResult } from 'express-validator';
import { getMessaging } from '../utils/firebaseAdminInit.js';

/**
 * Register device token
 */
export const registerToken = async (req, res) => {
  try {
    console.log('[registerToken] Request received:', {
      hasAuth: !!req.userId,
      userId: req.userId,
      bodyUserId: req.body.userId,
    });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[registerToken] Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { token, userId, deviceType, deviceInfo } = req.body;

    if (!token) {
      console.log('[registerToken] No token provided');
      return res.status(400).json({
        success: false,
        message: 'Token is required'
      });
    }

    // Determine target user: authenticated user > userId from body > find/create guest user
    let targetUser = null;
    
    if (req.userId) {
      // User is authenticated - use their account
      console.log('[registerToken] User authenticated, userId:', req.userId);
      targetUser = await User.findById(req.userId);
      if (!targetUser) {
        console.log('[registerToken] Authenticated user not found:', req.userId);
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
    } else if (userId && userId !== 'guest_user') {
      // User ID provided in body
      console.log('[registerToken] Using userId from body:', userId);
      targetUser = await User.findById(userId);
      if (!targetUser) {
        console.log('[registerToken] User from body not found:', userId);
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
    } else {
      // No authenticated user - try to find or create a guest user
      // For now, we'll create a guest user with a temporary email
      // In production, you might want to handle this differently
      console.log('[registerToken] No authenticated user, creating/finding guest user');
      
      // Try to find an existing guest user (you might want to use device ID or similar)
      // For simplicity, we'll create a guest user with token-based email
      const guestEmail = `guest_${token.substring(0, 10)}@wellorahealth.app`;
      targetUser = await User.findOne({ email: guestEmail });
      
      if (!targetUser) {
        console.log('[registerToken] Creating new guest user');
        targetUser = new User({
          email: guestEmail,
          // No password for guest users
        });
        await targetUser.save();
        console.log('[registerToken] Guest user created:', targetUser._id);
      } else {
        console.log('[registerToken] Found existing guest user:', targetUser._id);
      }
    }

    // Check if token already exists
    const existingTokenIndex = targetUser.deviceTokens.findIndex(
      dt => dt.token === token
    );

    if (existingTokenIndex >= 0) {
      console.log('[registerToken] Token already exists, updating device info');
      // Update existing token's device info
      targetUser.deviceTokens[existingTokenIndex].deviceType = deviceType || targetUser.deviceTokens[existingTokenIndex].deviceType || 'android';
      targetUser.deviceTokens[existingTokenIndex].deviceInfo = deviceInfo || targetUser.deviceTokens[existingTokenIndex].deviceInfo || {};
      targetUser.deviceTokens[existingTokenIndex].registeredAt = new Date();
    } else {
      console.log('[registerToken] Adding new token to user');
      // Add new token
      targetUser.deviceTokens.push({
        token,
        deviceType: deviceType || 'android',
        deviceInfo: deviceInfo || {},
        registeredAt: new Date()
      });
    }

    await targetUser.save();
    console.log('[registerToken] Token registered successfully for user:', targetUser._id);
    console.log('[registerToken] Total tokens for user:', targetUser.deviceTokens.length);

    res.json({
      success: true,
      message: 'Device token registered successfully',
      token,
      userId: targetUser._id.toString()
    });
  } catch (error) {
    console.error('[registerToken] Error:', error);
    console.error('[registerToken] Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to register device token',
      error: error.message
    });
  }
};

/**
 * Send push notification
 */
export const sendNotification = async (req, res) => {
  try {
    const messaging = getMessaging();
    if (!messaging) {
      return res.status(503).json({
        success: false,
        message: 'Push notifications not configured. Firebase Admin not initialized.'
      });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { title, body, data } = req.body;
    const user = await User.findById(req.userId);

    if (!user || !user.deviceTokens || user.deviceTokens.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No device tokens found for user'
      });
    }

    const tokens = user.deviceTokens.map(dt => dt.token);
    const message = {
      notification: {
        title,
        body
      },
      data: data || {},
      tokens
    };

    try {
      const response = await messaging.sendEachForMulticast(message);
      
      res.json({
        success: true,
        message: 'Notification sent successfully',
        successCount: response.successCount,
        failureCount: response.failureCount
      });
    } catch (error) {
      console.error('Firebase messaging error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to send notification',
        error: error.message
      });
    }
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send notification',
      error: error.message
    });
  }
};

/**
 * Get device tokens
 */
export const getTokens = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('deviceTokens');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      tokens: user.deviceTokens || []
    });
  } catch (error) {
    console.error('Get tokens error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get device tokens',
      error: error.message
    });
  }
};

/**
 * Remove device token
 */
export const removeToken = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.deviceTokens = user.deviceTokens.filter(
      dt => dt.token !== req.params.token
    );
    await user.save();

    res.json({
      success: true,
      message: 'Device token removed successfully'
    });
  } catch (error) {
    console.error('Remove token error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove device token',
      error: error.message
    });
  }
};
