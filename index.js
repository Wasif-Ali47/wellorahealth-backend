// IMPORTANT: load .env BEFORE any other import so modules that read
// process.env at the top level (e.g. openaiService.js) see the values.
import 'dotenv/config';

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dns from 'dns';
import path from 'path';
import { startReminderPushScheduler } from './services/reminderPushScheduler.js';
import { ensureFirebaseAdmin } from './utils/firebaseAdminInit.js';
import { logEmailConfigStatus, verifyEmailTransport } from './services/emailService.js';

const AUTH_BUILD_TAG = 'otp-email-v2';
console.error(`\n========== WELLORA HEALTH BACKEND [${AUTH_BUILD_TAG}] ==========\n`);

logEmailConfigStatus();
verifyEmailTransport().catch((err) => {
  console.error('[auth][otp] ⚠️ SMTP verify failed at startup:', err?.message || err);
  console.error('[auth][otp] OTP emails will likely fail until Gmail credentials are fixed.');
});

// Some ISPs / Windows resolvers fail SRV/TXT lookups required by mongodb+srv://
// (we see ESERVFAIL on queryTxt). Force a reliable public DNS resolver so the
// Atlas connection string can be resolved regardless of system DNS health.
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
  console.log('[dns] Using public resolvers:', dns.getServers().join(', '));
} catch (e) {
  console.warn('[dns] Failed to override DNS resolvers:', e.message);
}

const app = express();

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://adminnutriguide.vercel.app',
      'https://adminofallapss.oxmite.com',
      'https://allappsadminreact.oxmite.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for development - restrict in production
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Request logger (after body parser so POST bodies are visible)
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`➡️  ${req.method} ${req.originalUrl}`);
  if (req.body && Object.keys(req.body).length > 0) {
    const safe = { ...req.body };
    if (safe.password) safe.password = '***';
    console.log('   Body:', JSON.stringify(safe));
  }
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`⬅️  ${req.method} ${req.originalUrl} ${res.statusCode} (${duration} ms)`);
  });
  next();
});

// Routes
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import mealPlanRoutes from './routes/mealPlans.js';
import symptomRoutes from './routes/symptoms.js';
import reminderRoutes from './routes/reminders.js';
import doctorRoutes from './routes/doctors.js';
import chatRoutes from './routes/chat.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import adminAuthRoutes from './routes/adminAuth.js';
import foodRoutes from './routes/food.js';
import activityRoutes from './routes/activity.js';
import progressRoutes from './routes/progress.js';
import exportRoutes from './routes/export.js';
import logRoutes from './routes/logs.js';
import homeRoutes from './routes/home.js';
import knowledgeRoutes from './routes/knowledge.js';
import faqRoutes from './routes/faq.js';

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/meal-plans', mealPlanRoutes);
app.use('/api/symptoms', symptomRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/food', foodRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/faq', faqRoutes);

// API index (for humans / monitoring — lists main route groups)
app.get('/api', (req, res) => {
  res.json({
    name: 'Diabetic Diet AI Coach API',
    version: '1.0.0',
    health: '/api/health',
    routes: {
      auth: {
        base: '/api/auth',
        endpoints: [
          'POST /signup',
          'POST /verify-otp',
          'POST /resend-otp',
          'POST /register',
          'POST /login',
          'POST /guest',
          'POST /upgrade-guest',
          'GET /verify'
        ]
      },
      users: {
        base: '/api/users',
        note: 'All require Bearer token except none on this mount — use auth first.',
        endpoints: [
          'GET /profile',
          'PUT /profile/personal',
          'PUT /profile/body',
          'PUT /profile/health',
          'PUT /profile/diet',
          'PUT /settings',
          'PUT /onboarding/complete',
          'DELETE /account'
        ]
      },
      mealPlans: {
        base: '/api/meal-plans',
        endpoints: [
          'POST /generate',
          'POST /check-food',
          'POST /swap',
          'GET /grocery-list',
          'GET /current',
          'GET /',
          'GET /:id',
          'PUT /:id/days/:dayNumber'
        ]
      },
      chat: { base: '/api/chat', endpoints: ['POST /message', 'GET /history', 'GET /entitlement', 'POST /iap/verify'] },
      reminders: { base: '/api/reminders', endpoints: ['GET /', 'POST /', 'PUT /:id', 'DELETE /:id'] },
      export: { base: '/api/export', endpoints: ['GET /data'] },
      notifications: { base: '/api/notifications', endpoints: ['POST /register-token', 'POST /send'] },
      knowledge: {
        base: '/api/knowledge',
        note: 'AI Learning Knowledge Base. GET routes are public; write routes require admin JWT or KNOWLEDGE_API_KEY.',
        endpoints: [
          'GET /',
          'GET /stats',
          'GET /categories',
          'GET /merged',
          'GET /:id',
          'POST / (auth)',
          'PUT /:id (auth)',
          'PATCH /:id/deactivate (auth)',
          'PATCH /:id/reactivate (auth)',
          'DELETE /:id (auth)'
        ]
      }
    }
  });
});

// Log registered admin routes on startup
console.log('📋 Admin routes registered:');
console.log('   GET  /api/admin/test');
console.log('   GET  /api/admin/users');
console.log('   GET  /api/admin/meal-plans');
console.log('   POST /api/admin/notifications/broadcast');

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Diabetic Diet AI Coach API is running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'diabetic_diet_ai_coach';
const PORT = process.env.PORT || 5027;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set. Add it to backend/.env');
  process.exit(1);
}

mongoose.connect(MONGODB_URI, { dbName: MONGODB_DB_NAME })
  .then(() => {
    console.log(`✅ Connected to MongoDB (db: ${MONGODB_DB_NAME})`);
    const fb = ensureFirebaseAdmin();
    console.log('[reminderPush] Firebase Admin at startup:', fb ? 'ready (FCM can send)' : 'missing credentials (reminder pushes will not send)');
    startReminderPushScheduler();
    app.listen(PORT, () => {
      console.error(`🚀 Server running [${AUTH_BUILD_TAG}] on port ${PORT}`);
      console.log(`📡 API available at http://localhost:${PORT}/api`);
      console.error('[auth] OTP signup: POST /api/auth/signup → sends email via Gmail SMTP');
    });
  })
  .catch((error) => {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  });

export default app;
