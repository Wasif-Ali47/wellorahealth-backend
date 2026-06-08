import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: false // Optional for guest / Google users
  },
  googleId: {
    type: String,
    unique: true,
    sparse: true,
  },
  profileImageUrl: {
    type: String,
    default: null,
  },
  profileImagePath: {
    type: String,
    default: null,
  },
  otp: {
    type: String,
    default: null,
  },
  emailVerified: {
    type: Boolean,
    default: undefined,
  },
  resetOTP: {
    type: String,
    default: null,
  },
  firstName: {
    type: String,
    trim: true
  },
  lastName: {
    type: String,
    trim: true
  },
  dateOfBirth: {
    type: Date
  },
  biologicalSex: {
    type: String,
    enum: ['Female', 'Male', 'Other']
  },
  // Body info
  height: {
    feet: { type: Number },
    inches: { type: Number },
    cm: { type: Number } // Alternative format in centimeters
  },
  weight: {
    type: Number, // in kg
  },
  activityLevel: {
    type: String,
    enum: ['Sedentary', 'Lightly Active', 'Moderately Active', 'Very Active', 'Extremely Active']
  },
  // Health conditions
  healthConditions: [{
    type: String
  }],
  medications: [{
    name: String,
    dosage: String,
    timing: String // e.g. "08:00, 20:00" or "Before breakfast, After dinner"
  }],
  // Diet preferences
  dietPreferences: {
    vegetarian: { type: Boolean, default: false },
    vegan: { type: Boolean, default: false },
    glutenFree: { type: Boolean, default: false },
    dairyFree: { type: Boolean, default: false },
    allergies: [String],
    preferences: [String]
  },
  // ===== Diabetes-specific profile =====
  // Primary status: which group does the user fall under
  diabetesType: {
    type: String,
    enum: [
      'Type 1',
      'Type 2',
      'Pre-diabetes',
      'Insulin Resistance',
      'Gestational',
      'Obesity (At Risk)',
      'Family History (At Risk)',
      'Not Sure'
    ]
  },
  // Latest fasting blood sugar in mg/dL
  fastingSugar: { type: Number },
  // Latest HbA1c % value
  hba1c: { type: Number },
  // Food likes / dislikes (free-form list)
  foodLikes: [{ type: String }],
  foodDislikes: [{ type: String }],
  // Local foods the user commonly eats (roti, rice, daal, salan, qeema, biryani, fruits, etc.)
  localFoodPreferences: [{ type: String }],
  // Budget tier and cooking time preference
  budget: {
    type: String,
    enum: ['Low', 'Medium', 'High', 'Flexible']
  },
  cookingTime: {
    type: String,
    enum: ['Quick (<20 min)', 'Moderate (20-40 min)', 'Relaxed (40+ min)']
  },
  // Subscription
  subscriptionPlan: {
    type: String,
    enum: ['Free', 'Premium'],
    default: 'Free'
  },
  // Cross-device entitlement source of truth for Care AI chat.
  isPro: {
    type: Boolean,
    default: false
  },
  subscription: {
    platform: {
      type: String,
      enum: ['android', 'ios', 'web', 'none'],
      default: 'none'
    },
    productId: {
      type: String,
      trim: true
    },
    purchaseToken: {
      type: String,
      trim: true
    },
    originalTransactionId: {
      type: String,
      trim: true
    },
    status: {
      type: String,
      enum: ['inactive', 'active', 'expired', 'cancelled', 'verify_failed', 'unsupported'],
      default: 'inactive'
    },
    expiresAt: Date,
    lastVerifiedAt: Date,
    source: {
      type: String,
      default: 'none'
    }
  },
  // Care AI free-tier usage; does not reset on chat clear.
  careUsage: {
    totalMessagesUsed: {
      type: Number,
      default: 0,
      min: 0
    },
    updatedAt: Date
  },
  // Device tokens for push notifications
  deviceTokens: [{
    token: String,
    deviceType: String,
    deviceInfo: {
      os: String,
      appVersion: String
    },
    registeredAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Settings
  settings: {
    units: {
      type: String,
      enum: ['Metric', 'Imperial'],
      default: 'Metric'
    },
    darkMode: {
      type: Boolean,
      default: false
    },
    pushNotifications: {
      type: Boolean,
      default: true
    },
    cloudBackup: {
      type: Boolean,
      default: false
    },
    anonymousAnalytics: {
      type: Boolean,
      default: true
    }
  },
  // AI Coach questionnaire (post-intro onboarding)
  coachProfile: {
    mainGoal: { type: String },
    age: { type: Number },
    targetWeight: { type: Number },
    preferredCuisine: { type: String },
    foodAllergies: [{ type: String }],
    foodRestrictions: [{ type: String }],
    dietaryPreferences: [{ type: String }],
    likedFoods: [{ type: String }],
    foodsToAvoid: [{ type: String }],
    mealsPerDay: { type: String },
    mealManagement: { type: String },
    weightLossPace: { type: String },
    foodStyles: [{ type: String }],
    dailyRoutine: { type: String },
    foodPreparer: { type: String },
    weightLossProblems: [{ type: String }],
    mainGoalOther: { type: String },
    healthConditionsOther: { type: String },
    foodAllergiesOther: { type: String },
    foodRestrictionsOther: { type: String },
    foodStylesOther: { type: String },
    likedFoodsOther: { type: String },
    foodsToAvoidOther: { type: String },
    weightLossProblemsOther: { type: String },
    questionnaireComplete: { type: Boolean, default: false }
  },
  // Onboarding
  onboardingComplete: {
    type: Boolean,
    default: false
  },
  // Admin: User activation status
  active: {
    type: Boolean,
    default: true
  },
  // Ban state (set by admin)
  isBanned: {
    type: Boolean,
    default: false,
  },
  bannedAt: {
    type: Date,
    default: null,
  },
  bannedReason: {
    type: String,
    default: '',
  },
  // Cumulative OpenAI token usage per user
  openAiUsage: {
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    requestCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
  },
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON output; expose string `id` for clients that expect it
userSchema.methods.toJSON = function() {
  const userObject = this.toObject();
  delete userObject.password;
  if (userObject._id != null) {
    userObject.id = userObject._id.toString();
  }
  return userObject;
};

export default mongoose.model('User', userSchema);
