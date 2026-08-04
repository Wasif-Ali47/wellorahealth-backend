import express from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import * as chatController from '../controllers/chatController.js';

const router = express.Router();

// Send a message and get AI response
router.post('/message', authenticate, [
  body('message').trim().notEmpty()
], chatController.sendMessage);

// List conversations
router.get('/conversations', authenticate, chatController.getConversations);

// Get chat history (optional conversationId query)
router.get('/history', authenticate, chatController.getChatHistory);

// Rename one conversation
router.put('/conversations/:conversationId', authenticate, [
  body('title').trim().notEmpty()
], chatController.renameConversation);

// Clear chat history
router.delete('/history', authenticate, chatController.clearChatHistory);

// Get care entitlement status
router.get('/entitlement', authenticate, chatController.getCareEntitlement);

// Get care chat limit configuration
router.get('/limits', authenticate, chatController.getCareLimits);

// Verify in-app purchase and unlock premium
router.post('/iap/verify', authenticate, [
  body('platform').optional().isIn(['android', 'ios', 'web']),
  body('productId').trim().notEmpty(),
  body('purchaseToken').trim().notEmpty(),
  body('packageName').optional().trim(),
  body('transactionId').optional().trim(),
], chatController.verifyCarePurchase);

// Clear stale premium after a restore completes with no active purchases
router.post('/iap/restore/none', authenticate, chatController.clearCarePremiumAfterRestore);

export default router;
