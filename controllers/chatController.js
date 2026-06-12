import mongoose from 'mongoose';
import ChatMessage from '../models/ChatMessage.js';
import User from '../models/User.js';
import { generateChatResponse } from '../services/openaiService.js';
import { recordOpenAiUsage } from '../utils/trackUsage.js';
import { verifyIapPurchase } from '../services/iapVerificationService.js';
import { validationResult } from 'express-validator';
import {
  buildConversationTitle,
  newConversationId,
  parseDisplayTitle,
} from '../utils/chatConversationUtils.js';

function serializeMessage(doc) {
  return {
    id: doc._id,
    _id: doc._id,
    userId: doc.userId,
    message: doc.message,
    isUser: doc.isUser,
    confidence: doc.confidence,
    responseType: doc.responseType,
    conversationId: doc.conversationId,
    conversationTitle: doc.conversationTitle,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const FREE_CHAT_LIMIT = Number(process.env.CARE_FREE_CHAT_LIMIT || 5);
const REGISTERED_CHAT_LIMIT = Number(process.env.CARE_REGISTERED_CHAT_LIMIT || 15);

function computeUserIsPro(user) {
  if (user?.isPro) return true;
  return user?.subscriptionPlan === 'Premium';
}

function isGuestUser(user) {
  return /^guest_[^@]+@wellorahealth\.app$/i.test(String(user?.email || ''));
}

async function ensureUsageCounter(user) {
  const stored = Number(user?.careUsage?.totalMessagesUsed || 0);
  const counted = await ChatMessage.countDocuments({ userId: user._id, isUser: true });
  if (counted > stored) {
    user.careUsage = {
      totalMessagesUsed: counted,
      updatedAt: new Date(),
    };
    await user.save();
    return counted;
  }
  return stored;
}

async function buildEntitlement(user) {
  const totalUsed = await ensureUsageCounter(user);

  // Downgrade automatically if expiry passed.
  if (
    computeUserIsPro(user) &&
    user?.subscription?.expiresAt &&
    new Date(user.subscription.expiresAt).getTime() <= Date.now()
  ) {
    user.isPro = false;
    user.subscriptionPlan = 'Free';
    user.subscription = {
      ...(user.subscription || {}),
      status: 'expired',
    };
    await user.save();
  }

  const isPro = computeUserIsPro(user);
  const isGuest = isGuestUser(user);
  const limit = isGuest ? FREE_CHAT_LIMIT : REGISTERED_CHAT_LIMIT;
  const used = totalUsed;
  const remaining = isPro ? null : Math.max(0, limit - used);
  return {
    isPro,
    isGuest,
    freeLimit: limit,
    used,
    remaining,
    hardLocked: !isPro && totalUsed >= limit,
    subscription: {
      plan: user.subscriptionPlan || (isPro ? 'Premium' : 'Free'),
      status: user?.subscription?.status || (isPro ? 'active' : 'inactive'),
      productId: user?.subscription?.productId || null,
      platform: user?.subscription?.platform || 'none',
      expiresAt: user?.subscription?.expiresAt || null,
      lastVerifiedAt: user?.subscription?.lastVerifiedAt || null,
      source: user?.subscription?.source || 'none',
    },
  };
}

/**
 * Send message and get AI response
 */
export const sendMessage = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { message, conversationId: bodyConversationId, conversationTitle: bodyTitle } = req.body;
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Chat-only ban check — other features (meal plans etc.) are unaffected
    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_BANNED',
        message: 'Your account has been suspended. Please contact support.',
        bannedReason: user.bannedReason || '',
      });
    }

    const entitlement = await buildEntitlement(user);
    if (entitlement.hardLocked) {
      const accountType = entitlement.isGuest ? 'Guest' : 'Free';
      return res.status(402).json({
        success: false,
        code: 'CHAT_LIMIT_REACHED',
        message: `${accountType} chat limit reached. Upgrade to continue chatting.`,
        entitlement,
      });
    }

    let conversationId = bodyConversationId || newConversationId();
    let conversationTitle = bodyTitle;

    const existingInConvo = await ChatMessage.findOne({
      userId: req.userId,
      conversationId,
    }).select('conversationTitle').lean();

    if (existingInConvo?.conversationTitle) {
      conversationTitle = existingInConvo.conversationTitle;
    } else if (!conversationTitle) {
      conversationTitle = buildConversationTitle(message).storageTitle;
    }

    const recentMessages = await ChatMessage.find({
      userId: req.userId,
      conversationId,
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('message isUser')
      .lean();

    const userMessage = new ChatMessage({
      userId: req.userId,
      message,
      isUser: true,
      conversationId,
      conversationTitle,
    });
    await userMessage.save();
    user.careUsage = {
      totalMessagesUsed: Number(user?.careUsage?.totalMessagesUsed || 0) + 1,
      updatedAt: new Date(),
    };
    await user.save();
    const updatedEntitlement = await buildEntitlement(user);

    try {
      // Generate AI response using OpenAI
      const aiResponse = await generateChatResponse(
        message,
        user,
        recentMessages.reverse()
      );

      // Save AI response
      const aiMessage = new ChatMessage({
        userId: req.userId,
        message: aiResponse.text,
        isUser: false,
        confidence: aiResponse.confidence,
        responseType: aiResponse.type,
        conversationId,
        conversationTitle,
      });
      await aiMessage.save();
      recordOpenAiUsage(req.userId, aiResponse.usage, 'care-chat', 'gpt-4o-mini').catch(() => {});

      res.json({
        success: true,
        entitlement: updatedEntitlement,
        conversationId,
        conversationTitle,
        userMessage: serializeMessage(userMessage),
        aiMessage: serializeMessage(aiMessage),
      });
    } catch (openaiError) {
      console.error('OpenAI error:', openaiError);
      
      // Fallback response if OpenAI fails
      const fallbackResponse = getFallbackResponse(message, user);
      
      const aiMessage = new ChatMessage({
        userId: req.userId,
        message: fallbackResponse.text,
        isUser: false,
        confidence: fallbackResponse.confidence,
        responseType: fallbackResponse.type,
        conversationId,
        conversationTitle,
      });
      await aiMessage.save();

      res.json({
        success: true,
        entitlement: updatedEntitlement,
        conversationId,
        conversationTitle,
        userMessage: serializeMessage(userMessage),
        aiMessage: serializeMessage(aiMessage),
      });
    }
  } catch (error) {
    console.error('Chat message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process message',
      error: error.message
    });
  }
};

/**
 * Get chat history
 */
export const getChatHistory = async (req, res) => {
  try {
    const { limit = 100, conversationId } = req.query;
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const filter = { userId: req.userId };
    if (conversationId === 'legacy') {
      filter.$or = [
        { conversationId: null },
        { conversationId: { $exists: false } },
      ];
    } else if (conversationId) {
      filter.conversationId = conversationId;
    }

    const messages = await ChatMessage.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10));

    messages.reverse();

    res.json({
      success: true,
      count: messages.length,
      entitlement: await buildEntitlement(user),
      messages: messages.map(serializeMessage),
    });
  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get chat history',
      error: error.message
    });
  }
};

/**
 * List chat conversations (one tile per chat, not per message).
 */
export const getConversations = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userObjectId = new mongoose.Types.ObjectId(req.userId);
    const rows = await ChatMessage.aggregate([
      { $match: { userId: userObjectId } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: {
            $ifNull: ['$conversationId', 'legacy'],
          },
          conversationTitle: { $first: '$conversationTitle' },
          updatedAt: { $first: '$createdAt' },
          preview: { $first: '$message' },
          isUser: { $first: '$isUser' },
        },
      },
      { $sort: { updatedAt: -1 } },
    ]);

    const conversations = rows.map((row) => {
      const storageTitle = row.conversationTitle || row.preview || 'Chat';
      return {
        conversationId: row._id,
        conversationTitle: storageTitle,
        displayTitle: parseDisplayTitle(storageTitle),
        updatedAt: row.updatedAt,
        preview: row.preview,
      };
    });

    res.json({
      success: true,
      conversations,
    });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list conversations',
      error: error.message,
    });
  }
};

/**
 * Rename a conversation by updating all messages in that conversation.
 */
export const renameConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { title } = req.body;
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    const filter = { userId: req.userId };
    if (conversationId === 'legacy') {
      filter.$or = [
        { conversationId: null },
        { conversationId: { $exists: false } },
      ];
    } else {
      filter.conversationId = conversationId;
    }

    const result = await ChatMessage.updateMany(filter, {
      $set: { conversationTitle: cleanTitle },
    });

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    res.json({
      success: true,
      conversationId,
      conversationTitle: cleanTitle,
      displayTitle: parseDisplayTitle(cleanTitle),
    });
  } catch (error) {
    console.error('Rename conversation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to rename conversation',
      error: error.message,
    });
  }
};

/**
 * Clear chat history (all or one conversation).
 */
export const clearChatHistory = async (req, res) => {
  try {
    const { conversationId } = req.query;
    const filter = { userId: req.userId };
    if (conversationId === 'legacy') {
      filter.$or = [
        { conversationId: null },
        { conversationId: { $exists: false } },
      ];
    } else if (conversationId) {
      filter.conversationId = conversationId;
    }
    await ChatMessage.deleteMany(filter);

    res.json({
      success: true,
      message: conversationId
        ? 'Conversation deleted successfully'
        : 'Chat history cleared successfully',
    });
  } catch (error) {
    console.error('Clear chat history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear chat history',
      error: error.message
    });
  }
};

/**
 * Get entitlement status for Care AI chat.
 */
export const getCareEntitlement = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.json({
      success: true,
      entitlement: await buildEntitlement(user),
    });
  } catch (error) {
    console.error('Get care entitlement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch entitlement',
      error: error.message,
    });
  }
};

/**
 * Verify in-app purchase and persist premium entitlement on user.
 */
export const verifyCarePurchase = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array(),
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const {
      platform = 'android',
      productId,
      purchaseToken,
      packageName,
      transactionId,
    } = req.body;

    const verification = await verifyIapPurchase({
      platform,
      productId,
      purchaseToken,
      packageName,
    });

    if (!verification.ok) {
      return res.status(400).json({
        success: false,
        message: 'Purchase verification failed',
        verification,
        entitlement: await buildEntitlement(user),
      });
    }

    user.isPro = true;
    user.subscriptionPlan = 'Premium';
    user.subscription = {
      platform,
      productId,
      purchaseToken,
      originalTransactionId: transactionId || null,
      status: verification.status || 'active',
      expiresAt: verification.expiresAt ? new Date(verification.expiresAt) : null,
      source: verification.source || 'unknown',
      lastVerifiedAt: new Date(),
    };
    await user.save();

    res.json({
      success: true,
      message: 'Purchase verified and premium unlocked',
      verification,
      entitlement: await buildEntitlement(user),
    });
  } catch (error) {
    console.error('Verify purchase error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify purchase',
      error: error.message,
    });
  }
};

/**
 * Fallback response if OpenAI fails
 */
function getFallbackResponse(userMessage, user) {
  const lowerMessage = userMessage.toLowerCase();
  let response;
  let confidence = 0.75;
  let type = 'default';

  if (lowerMessage.includes('sugar') || lowerMessage.includes('glucose') || lowerMessage.includes('hba1c') || lowerMessage.includes('diabetes')) {
    response = 'For steady blood sugar, prioritise low-GI foods (whole-wheat roti, daal, brown rice in small portions, non-starchy vegetables), pair carbs with protein, and walk 10-15 minutes after meals.';
    confidence = 0.90;
    type = 'blood_sugar';
  } else if (lowerMessage.includes('eat') || lowerMessage.includes('can i have') || lowerMessage.includes('meal') || lowerMessage.includes('food') || lowerMessage.includes('roti') || lowerMessage.includes('rice') || lowerMessage.includes('biryani') || lowerMessage.includes('fruit')) {
    response = 'Keep the portion small (e.g. 1 roti, ½ cup rice, 1 small fruit) and pair it with protein or fibre. Check your personalised plan in the My Plan tab for safe portion sizes.';
    confidence = 0.92;
    type = 'meal_plan';
  } else if (lowerMessage.includes('medication') || lowerMessage.includes('medicine') || lowerMessage.includes('insulin') || lowerMessage.includes('metformin') || lowerMessage.includes('pill')) {
    response = 'Take diabetic medication exactly as prescribed and time it around meals. Never change the dose without talking to your doctor.';
    confidence = 0.85;
    type = 'medication';
  } else if (lowerMessage.includes('symptom') || lowerMessage.includes('dizzy') || lowerMessage.includes('tired') || lowerMessage.includes('thirsty')) {
    response = 'Frequent thirst, fatigue or dizziness can signal that sugar is too high or too low. Log a reading now and contact your doctor if symptoms persist.';
    confidence = 0.88;
    type = 'symptoms';
  } else {
    response = 'I can help with daily diabetic meals, sugar-safe portions, food swaps and "Can I eat this?" questions. For medical decisions, please consult your doctor.';
    confidence = 0.75;
    type = 'default';
  }

  if (user.diabetesType) {
    response += ` (Tailored for ${user.diabetesType}.)`;
  }

  return { text: response, confidence, type };
}
