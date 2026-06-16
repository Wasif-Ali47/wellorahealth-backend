import mongoose from 'mongoose';

const chatUsageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      default: null,
    },
    requestType: {
      type: String,
      enum: ['guest', 'authenticated'],
      default: 'authenticated',
    },
    feature: {
      type: String,
      enum: [
        'meal-plan',
        'meal-plan-day',
        'food-safety-check',
        'food-swap',
        'grocery-list',
        'natural-log',
        'care-chat',
        'faq-chat',
      ],
      default: 'care-chat',
    },
    model: {
      type: String,
      default: '',
    },
    usage: {
      promptTokens: { type: Number, default: 0 },
      completionTokens: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

export default mongoose.model('ChatUsage', chatUsageSchema);
