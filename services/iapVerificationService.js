import axios from 'axios';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_ANDROID_PACKAGE_NAME = 'com.wellorahealth.app.aiappspace';
const ACTIVE_V2_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_CANCELED',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);

let cachedAccessToken = null;
let cachedAccessTokenExpMs = 0;

function strictVerifyEnabled() {
  return (
    process.env.IAP_ANDROID_STRICT_VERIFY === '1' ||
    process.env.IAP_ANDROID_STRICT_VERIFY === 'true'
  );
}

function loadGoogleServiceAccount() {
  if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      console.warn('[iapVerify] Invalid GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    }
  }

  try {
    const p = path.join(__dirname, '..', 'google-play-service-account.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {
    console.warn('[iapVerify] Could not read google-play-service-account.json:', e.message);
  }

  return null;
}

async function getGoogleAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessTokenExpMs - 60 * 1000) {
    return cachedAccessToken;
  }

  const sa = loadGoogleServiceAccount();
  if (!sa?.client_email || !sa?.private_key) {
    throw new Error('Google Play service account is missing');
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: GOOGLE_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp,
    },
    sa.private_key,
    { algorithm: 'RS256' }
  );

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const { data } = await axios.post(GOOGLE_OAUTH_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpMs = now + (Number(data.expires_in || 3600) * 1000);
  return cachedAccessToken;
}

function buildAndroidSubscriptionResult(data) {
  const now = Date.now();
  const expiryMs = Number(data?.expiryTimeMillis || 0);
  const paymentState = data?.paymentState;
  const cancelReason = data?.cancelReason;
  const autoRenewing = data?.autoRenewing;

  // paymentState: 0 pending, 1 received, 2 free trial, 3 deferred upgrade/downgrade
  const paymentOk =
    paymentState === undefined ||
    paymentState === null ||
    paymentState === 1 ||
    paymentState === 2 ||
    paymentState === 3;

  const active = expiryMs > now && paymentOk;
  const status = active ? 'active' : 'expired';

  return {
    ok: active,
    status,
    expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
    platform: 'android',
    source: 'google_play',
    payload: {
      paymentState,
      cancelReason,
      autoRenewing,
      orderId: data?.orderId,
      priceCurrencyCode: data?.priceCurrencyCode,
      priceAmountMicros: data?.priceAmountMicros,
      countryCode: data?.countryCode,
      purchaseType: data?.purchaseType,
      acknowledgementState: data?.acknowledgementState,
      kind: data?.kind,
    },
  };
}

function parseTime(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function buildAndroidSubscriptionV2Result(data, productId) {
  const now = Date.now();
  const lineItems = Array.isArray(data?.lineItems) ? data.lineItems : [];
  const matchingLine =
    lineItems.find((item) => item?.productId === productId) || lineItems[0] || null;
  const expiryMs = Math.max(
    0,
    ...lineItems
      .map((item) => parseTime(item?.expiryTime))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
  );
  const subscriptionState = data?.subscriptionState;
  const active = expiryMs > now && ACTIVE_V2_STATES.has(subscriptionState);
  const autoRenewingPlan = matchingLine?.autoRenewingPlan || null;

  return {
    ok: active,
    status: active ? 'active' : 'expired',
    expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
    platform: 'android',
    source: 'google_play_v2',
    payload: {
      subscriptionState,
      acknowledgementState: data?.acknowledgementState,
      linkedPurchaseToken: data?.linkedPurchaseToken,
      regionCode: data?.regionCode,
      latestSuccessfulOrderId: matchingLine?.latestSuccessfulOrderId,
      productId: matchingLine?.productId,
      autoRenewEnabled: autoRenewingPlan?.autoRenewEnabled,
      planType: matchingLine?.autoRenewingPlan
        ? 'auto_renewing'
        : matchingLine?.prepaidPlan
          ? 'prepaid'
          : null,
      kind: data?.kind,
    },
  };
}

async function verifyAndroidPurchase({ packageName, productId, purchaseToken }) {
  if (!packageName || !productId || !purchaseToken) {
    throw new Error('Missing packageName/productId/purchaseToken');
  }

  const accessToken = await getGoogleAccessToken();

  const v2Url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    packageName
  )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

  try {
    const { data } = await axios.get(v2Url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
    return buildAndroidSubscriptionV2Result(data, productId);
  } catch (e) {
    const status = e?.response?.status;
    const message = e?.response?.data?.error?.message || e.message;
    console.warn('[iapVerify] subscriptionsv2 failed; trying legacy endpoint:', message || status);
  }

  const legacyUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    packageName
  )}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(
    purchaseToken
  )}`;

  const { data } = await axios.get(legacyUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });

  return buildAndroidSubscriptionResult(data);
}

export async function verifyIapPurchase({
  platform,
  productId,
  purchaseToken,
  packageName,
}) {
  if (platform !== 'android') {
    return {
      ok: false,
      status: 'unsupported_platform',
      platform,
      source: 'none',
      expiresAt: null,
      payload: {},
      reason: 'Only android verification is implemented on this backend',
    };
  }

  const appPackage = packageName || process.env.ANDROID_PACKAGE_NAME || DEFAULT_ANDROID_PACKAGE_NAME;
  try {
    return await verifyAndroidPurchase({
      packageName: appPackage,
      productId,
      purchaseToken,
    });
  } catch (e) {
    const strict = strictVerifyEnabled();
    console.warn('[iapVerify] Android verification failed:', e.message);
    if (strict) {
      return {
        ok: false,
        status: 'verify_failed',
        platform: 'android',
        source: 'google_play',
        expiresAt: null,
        payload: {},
        reason: e.message,
      };
    }

    // Development fallback: allows end-to-end UI testing when Play API is not configured.
    return {
      ok: Boolean(purchaseToken && productId),
      status: purchaseToken && productId ? 'active' : 'verify_failed',
      platform: 'android',
      source: 'fallback_dev',
      expiresAt: null,
      payload: { warning: 'strict verification disabled' },
      reason: strict ? e.message : 'Strict verification disabled; using fallback',
    };
  }
}
