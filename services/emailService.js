import nodemailer from 'nodemailer';

/** Strip optional quotes from .env values (common copy-paste mistake). */
function cleanEnv(value) {
  if (value == null) return '';
  let v = String(value).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function getEmailCredentials() {
  const user = cleanEnv(process.env.EMAIL_USER);
  const pass = cleanEnv(process.env.EMAIL_PASS);
  return { user, pass };
}

/**
 * Gmail SMTP — same approach as sample_backend sendEmail (port 587).
 * More reliable than nodemailer `service: 'gmail'` on some networks.
 */
function createSmtpTransporter() {
  const { user, pass } = getEmailCredentials();
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user, pass },
  });
}

/**
 * Verify SMTP credentials at startup (optional).
 */
export async function verifyEmailTransport() {
  const { user, pass } = getEmailCredentials();
  if (!user || !pass) {
    console.warn('[auth][otp] SMTP verify skipped — EMAIL_USER/EMAIL_PASS not set');
    return false;
  }
  console.log(`[auth][otp] Verifying SMTP connection for ${user}...`);
  const transporter = createSmtpTransporter();
  await transporter.verify();
  console.log('[auth][otp] SMTP connection verified OK');
  return true;
}

/**
 * Send 6-digit email verification OTP (sample_backend behavior + strict errors).
 */
export async function sendOTPEmail(email, otp) {
  const to = email?.trim().toLowerCase();
  const code = String(otp).trim();
  const { user, pass } = getEmailCredentials();

  console.log('────────────────────────────────────────');
  console.log(`[auth][otp] sendOTPEmail called to=${to}`);

  if (!to || !code) {
    console.error('[auth][otp] FAILED: missing email or otp');
    throw new Error('Missing email or OTP');
  }

  if (!user || !pass) {
    console.error('[auth][otp] FAILED: EMAIL_USER or EMAIL_PASS missing in backend/.env');
    console.error(`[auth][otp] DEV ONLY — OTP for ${to}: ${code}`);
    throw new Error('EMAIL_NOT_CONFIGURED');
  }

  const isDev = process.env.NODE_ENV !== 'production';
  const subject = 'Wellora Health — Email Verification Code';
  const text = `Your verification code is: ${code}\n\nEnter this 6-digit code in the app. It expires when you verify your email.\n\nIf you did not sign up, ignore this email.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#006B4D;margin:0 0 12px">Wellora Health</h2>
      <p style="color:#333;font-size:15px;line-height:1.5">Your email verification code is:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#006B4D;margin:16px 0">${code}</p>
      <p style="color:#666;font-size:13px">Enter this code in the app to verify your account.</p>
    </div>
  `;

  console.log(`[auth][otp] Sending via smtp.gmail.com:587 from=${user} to=${to} ...`);

  try {
    const transporter = createSmtpTransporter();
    const info = await transporter.sendMail({
      from: `"Wellora Health" <${user}>`,
      to,
      subject,
      text,
      html,
    });

    console.log(
      `[auth][otp] ✅ EMAIL SENT SUCCESS to=${to} messageId=${info.messageId ?? 'n/a'}`
    );
    console.log(`[auth][otp] SMTP response: ${info.response ?? 'n/a'}`);
    if (isDev) {
      console.log(`[auth][otp] (dev) OTP code was: ${code}`);
    }
    console.log('────────────────────────────────────────');
    return info;
  } catch (err) {
    console.error(`[auth][otp] ❌ EMAIL SEND FAILED to=${to}`);
    console.error(`[auth][otp] error message: ${err?.message || err}`);
    if (err?.code) console.error(`[auth][otp] error code: ${err.code}`);
    if (err?.response) console.error(`[auth][otp] SMTP response: ${err.response}`);
    if (isDev) {
      console.error(`[auth][otp] (dev) OTP would have been: ${code}`);
    }
    console.log('────────────────────────────────────────');
    throw err;
  }
}

export async function sendEmail(email, subject, text) {
  if (!email || !subject || !text) {
    console.error('[auth][email] sendEmail: missing email, subject, or text');
    return;
  }

  const { user, pass } = getEmailCredentials();
  if (!user || !pass) {
    console.warn(
      `[auth][email] Skipped (set EMAIL_USER + EMAIL_PASS). To: ${email} | ${subject}`
    );
    return;
  }

  console.log(`[auth][email] Sending "${subject}" to ${email}...`);

  try {
    const transporter = createSmtpTransporter();
    const info = await transporter.sendMail({
      from: `"Wellora Health" <${user}>`,
      to: email,
      subject,
      text,
    });

    console.log(`[auth][email] SUCCESS to=${email} messageId=${info.messageId ?? 'n/a'}`);
    return info;
  } catch (err) {
    console.error('[auth][email] FAILED to=%s error=%s', email, err?.message || err);
    throw err;
  }
}

/** Log whether OTP emails can be sent (call at server startup). */
export function logEmailConfigStatus() {
  const { user, pass } = getEmailCredentials();
  console.log('────────────────────────────────────────');
  if (user && pass) {
    console.log(`[auth][otp] Email configured: YES`);
    console.log(`[auth][otp] Sender (EMAIL_USER): ${user}`);
    console.log(`[auth][otp] App password length: ${pass.length} chars`);
    console.log('[auth][otp] Transport: smtp.gmail.com:587');
  } else {
    console.warn('[auth][otp] Email configured: NO');
    console.warn('[auth][otp] Set EMAIL_USER and EMAIL_PASS in backend/.env');
    console.warn('[auth][otp] Use a Gmail App Password (Google Account → Security → 2FA → App passwords)');
  }
  console.log('────────────────────────────────────────');
}
