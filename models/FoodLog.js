import mongoose from 'mongoose';

const foodLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  foodName: {
    type: String,
    required: true,
    trim: true
  },
  /** Original human-language input */
  rawDescription: {
    type: String,
    trim: true
  },
  /** AI-organized one-line summary for history UI */
  organizedSummary: {
    type: String,
    trim: true
  },
  /** Structured breakdown from AI (items, portions, etc.) */
  parsedDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  portionSize: {
    amount: { type: Number, required: true },
    unit: { type: String, required: true, enum: ['g', 'ml', 'cup', 'piece', 'serving'] }
  },
  calories: {
    type: Number,
    required: true,
    min: 0
  },
  macros: {
    carbs: { type: Number, default: 0 },
    protein: { type: Number, default: 0 },
    fat: { type: Number, default: 0 },
    fibre: { type: Number, default: 0 }
  },
  barcode: {
    type: String,
    trim: true,
    sparse: true
  },
  mealType: {
    type: String,
    enum: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    default: 'Snack'
  },
  source: {
    type: String,
    enum: ['manual', 'meal_plan'],
    default: 'manual'
  },
  status: {
    type: String,
    enum: ['completed', 'skipped'],
    default: 'completed'
  },
  plannedMealKey: {
    type: String,
    trim: true
  },
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
foodLogSchema.index({ userId: 1, date: -1 });
foodLogSchema.index({ userId: 1, timestamp: -1 });

export default mongoose.model('FoodLog', foodLogSchema);
