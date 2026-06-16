import mongoose from 'mongoose';
import User from '../models/User.js';
import MealPlan from '../models/MealPlan.js';
import ChatUsage from '../models/ChatUsage.js';
import { getMessaging } from '../utils/firebaseAdminInit.js';

/**
 * GET /api/admin/usage
 */
export const getUsageOverview = async (req, res) => {
  try {
    const [userAgg, chatAgg] = await Promise.all([
      User.aggregate([
        {
          $group: {
            _id: null,
            users: { $sum: 1 },
            bannedUsers: { $sum: { $cond: [{ $eq: ['$isBanned', true] }, 1, 0] } },
          },
        },
      ]),
      ChatUsage.aggregate([
        {
          $group: {
            _id: null,
            totalTokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
            totalRequests: { $sum: 1 },
          },
        },
      ]),
    ]);

    const summary = {
      users: userAgg[0]?.users || 0,
      bannedUsers: userAgg[0]?.bannedUsers || 0,
      totalTokens: chatAgg[0]?.totalTokens || 0,
      totalRequests: chatAgg[0]?.totalRequests || 0,
    };

    console.log(`[admin/usage] users=${summary.users} banned=${summary.bannedUsers} tokens=${summary.totalTokens} requests=${summary.totalRequests}`);

    return res.json({ success: true, summary });
  } catch (error) {
    console.error('[admin/usage] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch usage overview' });
  }
};

/**
 * GET /api/admin/users
 */
export const getUsers = async (req, res) => {
  try {
    const [users, chatAgg] = await Promise.all([
      User.find({}).select('-password -otp -resetOTP').sort({ createdAt: -1 }).lean(),
      ChatUsage.aggregate([
        { $match: { userId: { $ne: null } } },
        {
          $group: {
            _id: '$userId',
            totalTokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
            requestCount: { $sum: 1 },
            lastUsedAt: { $max: '$createdAt' },
          },
        },
      ]),
    ]);

    // Build a lookup map: userId string -> chat stats
    const chatMap = {};
    for (const row of chatAgg) {
      chatMap[String(row._id)] = row;
    }

    const rows = users.map((u) => {
      const chat = chatMap[String(u._id)] || {};
      return {
        id: u._id,
        email: u.email || '',
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        emailVerified: !!u.emailVerified,
        healthConditions: u.healthConditions || [],
        onboardingComplete: u.onboardingComplete || false,
        active: u.active !== false,
        isBanned: !!u.isBanned,
        bannedAt: u.bannedAt || null,
        bannedReason: u.bannedReason || '',
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        deviceTokenCount: Array.isArray(u.deviceTokens) ? u.deviceTokens.length : 0,
        openAiUsage: {
          totalTokens: Number(chat.totalTokens) || 0,
          requestCount: Number(chat.requestCount) || 0,
          lastUsedAt: chat.lastUsedAt || null,
        },
      };
    });

    return res.json({ success: true, users: rows });
  } catch (error) {
    console.error('[admin:getUsers] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch users', error: error.message });
  }
};

/**
 * PUT /api/admin/users/:id
 */
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const allowedFields = ['firstName', 'lastName', 'email', 'emailVerified'];
    const payload = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) payload[key] = req.body[key];
    }

    if (payload.email && typeof payload.email === 'string') {
      payload.email = payload.email.trim().toLowerCase();
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    const user = await User.findByIdAndUpdate(id, payload, { new: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    return res.json({ success: true, message: 'User updated successfully', user });
  } catch (error) {
    console.error('[admin:updateUser] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update user', error: error.message });
  }
};

/**
 * PATCH /api/admin/users/:id/ban
 */
export const setUserBanState = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const banValue = req.body?.isBanned;
    const isBanned = banValue === true || banValue === 'true' || banValue === 1 || banValue === '1';
    // Ban only affects chat access; `active` is NOT changed here so
    // meal-plan generation and all other features keep working.
    const update = {
      isBanned,
      bannedAt: isBanned ? new Date() : null,
      bannedReason: isBanned ? String(req.body?.bannedReason || '').trim() : '',
    };

    const user = await User.findByIdAndUpdate(id, update, { new: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    return res.json({
      success: true,
      message: isBanned ? 'User banned successfully' : 'User unbanned successfully',
      user: {
        id: user._id,
        email: user.email,
        isBanned: user.isBanned,
        bannedAt: user.bannedAt,
        bannedReason: user.bannedReason,
      },
    });
  } catch (error) {
    console.error('[admin:setUserBanState] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update user ban state', error: error.message });
  }
};

/**
 * PATCH /api/admin/users/:id/toggle  (legacy activate/deactivate)
 */
export const toggleUserActive = async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;

    if (!id) return res.status(400).json({ success: false, message: 'User ID is required' });

    const user = await User.findByIdAndUpdate(id, { active: !!active }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    return res.json({
      success: true,
      message: `User ${active ? 'activated' : 'deactivated'} successfully`,
      user: { id: user._id, email: user.email, active: user.active },
    });
  } catch (error) {
    console.error('[admin:toggleUserActive] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update user status', error: error.message });
  }
};

/**
 * GET /api/admin/meal-plans
 */
export const getAllMealPlans = async (req, res) => {
  try {
    const plans = await MealPlan.find({}).sort({ createdAt: -1 }).limit(100).lean();

    const formatted = plans.map((p) => ({
      id: p._id,
      userId: p.userId,
      planName: p.planName,
      startDate: p.startDate,
      endDate: p.endDate,
      dailyCalorieTarget: p.dailyCalorieTarget,
      dailyMacroTargets: p.dailyMacroTargets,
      isActive: p.isActive,
    }));

    return res.json({ success: true, mealPlans: formatted });
  } catch (error) {
    console.error('[admin:getAllMealPlans] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch meal plans', error: error.message });
  }
};

/**
 * POST /api/admin/notifications/broadcast
 */
export const broadcastNotification = async (req, res) => {
  try {
    const messaging = getMessaging();
    if (!messaging) {
      return res.status(503).json({
        success: false,
        message: 'Push notifications not configured. Place firebase-service-account.json in backend/ or set FIREBASE_SERVICE_ACCOUNT.',
      });
    }

    const { title, body } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Title and body are required' });
    }

    const usersWithTokens = await User.find({
      'deviceTokens.0': { $exists: true },
      isBanned: { $ne: true },
      $or: [{ active: { $exists: false } }, { active: true }],
    }).select('deviceTokens');

    const tokensSet = new Set();
    usersWithTokens.forEach((user) => {
      (user.deviceTokens || []).forEach((dt) => {
        if (dt?.token) tokensSet.add(dt.token);
      });
    });

    const allTokens = Array.from(tokensSet);
    if (allTokens.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No device tokens found. Notification not sent.',
        totalTokens: 0,
        successCount: 0,
        failureCount: 0,
      });
    }

    const chunkSize = 500;
    let totalSuccess = 0;
    let totalFailure = 0;

    for (let i = 0; i < allTokens.length; i += chunkSize) {
      const chunk = allTokens.slice(i, i + chunkSize);
      try {
        const response = await messaging.sendEachForMulticast({
          notification: { title, body },
          data: { type: 'broadcast' },
          tokens: chunk,
        });
        totalSuccess += response.successCount || 0;
        totalFailure += response.failureCount || 0;
      } catch (err) {
        console.error('[admin:broadcastNotification] chunk error:', err);
        totalFailure += chunk.length;
      }
    }

    return res.json({
      success: true,
      message: 'Broadcast notification sent',
      totalTokens: allTokens.length,
      successCount: totalSuccess,
      failureCount: totalFailure,
    });
  } catch (error) {
    console.error('[admin:broadcastNotification] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send notification', error: error.message });
  }
};

/**
 * GET /api/admin/chat/usage
 */
export const getChatUsageOverview = async (req, res) => {
  try {
    const agg = await ChatUsage.aggregate([
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          authenticatedRequests: {
            $sum: { $cond: [{ $eq: ['$requestType', 'authenticated'] }, 1, 0] },
          },
          guestRequests: {
            $sum: { $cond: [{ $eq: ['$requestType', 'guest'] }, 1, 0] },
          },
          totalPromptTokens: { $sum: { $ifNull: ['$usage.promptTokens', 0] } },
          totalCompletionTokens: { $sum: { $ifNull: ['$usage.completionTokens', 0] } },
          totalTokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
        },
      },
    ]);

    const summary = agg[0] || {
      totalRequests: 0,
      authenticatedRequests: 0,
      guestRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
    };
    delete summary._id;

    const topChatUsers = await ChatUsage.aggregate([
      { $match: { userId: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: '$userId',
          requestCount: { $sum: 1 },
          promptTokens: { $sum: { $ifNull: ['$usage.promptTokens', 0] } },
          completionTokens: { $sum: { $ifNull: ['$usage.completionTokens', 0] } },
          totalTokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
          lastUsedAt: { $max: '$createdAt' },
        },
      },
      { $sort: { totalTokens: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
    ]);

    const topUsers = topChatUsers.map((item) => ({
      userId: item._id,
      name: `${item.user?.[0]?.firstName || ''} ${item.user?.[0]?.lastName || ''}`.trim(),
      email: item.user?.[0]?.email || '',
      requestCount: item.requestCount,
      promptTokens: item.promptTokens,
      completionTokens: item.completionTokens,
      totalTokens: item.totalTokens,
      lastUsedAt: item.lastUsedAt,
    }));

    return res.json({ success: true, summary, topUsers });
  } catch (error) {
    console.error('[admin:getChatUsageOverview] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch chat usage overview', error: error.message });
  }
};

/**
 * GET /api/admin/chat/usage/user/:userId
 */
export const getUserChatUsage = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const user = await User.findById(userId).select('firstName lastName email');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const usageStats = await ChatUsage.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: null,
          requestCount: { $sum: 1 },
          promptTokens: { $sum: { $ifNull: ['$usage.promptTokens', 0] } },
          completionTokens: { $sum: { $ifNull: ['$usage.completionTokens', 0] } },
          totalTokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
          firstRequestAt: { $min: '$createdAt' },
          lastRequestAt: { $max: '$createdAt' },
        },
      },
    ]);

    const stats = usageStats[0] || {
      requestCount: 0, promptTokens: 0, completionTokens: 0,
      totalTokens: 0, firstRequestAt: null, lastRequestAt: null,
    };
    delete stats._id;

    const recentRequests = await ChatUsage.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({
      success: true,
      user: {
        id: user._id,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        email: user.email,
      },
      stats,
      recentRequests: recentRequests.map((r) => ({
        id: r._id,
        feature: r.feature,
        model: r.model,
        requestType: r.requestType,
        promptTokens: r.usage?.promptTokens || 0,
        completionTokens: r.usage?.completionTokens || 0,
        totalTokens: r.usage?.totalTokens || 0,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    console.error('[admin:getUserChatUsage] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch user chat usage', error: error.message });
  }
};

/**
 * GET /api/admin/chat/usage/guest
 */
export const getGuestChatStats = async (req, res) => {
  try {
    const agg = await ChatUsage.aggregate([
      { $match: { requestType: 'guest' } },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalPromptTokens: { $sum: { $ifNull: ['$usage.promptTokens', 0] } },
          totalCompletionTokens: { $sum: { $ifNull: ['$usage.completionTokens', 0] } },
          totalTokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
          firstRequestAt: { $min: '$createdAt' },
          lastRequestAt: { $max: '$createdAt' },
        },
      },
    ]);

    const summary = agg[0] || {
      totalRequests: 0, totalPromptTokens: 0, totalCompletionTokens: 0,
      totalTokens: 0, firstRequestAt: null, lastRequestAt: null,
    };
    delete summary._id;

    const avgTokens = summary.totalRequests > 0
      ? Math.round(summary.totalTokens / summary.totalRequests)
      : 0;

    return res.json({ success: true, summary: { ...summary, averageTokensPerRequest: avgTokens } });
  } catch (error) {
    console.error('[admin:getGuestChatStats] error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch guest chat stats', error: error.message });
  }
};
