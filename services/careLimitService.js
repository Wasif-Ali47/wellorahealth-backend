function parseLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const GUEST_CHAT_LIMIT = parseLimit(process.env.CARE_FREE_CHAT_LIMIT, 5);
export const REGISTERED_CHAT_LIMIT = parseLimit(
  process.env.CARE_REGISTERED_CHAT_LIMIT,
  15
);

export function computeUserIsPro(user) {
  if (user?.isPro) return true;
  return user?.subscriptionPlan === 'Premium';
}

export function isGuestUser(user) {
  if (user?.emailVerified === false) return true;
  return /^guest_[^@]+@wellorahealth\.app$/i.test(String(user?.email || ''));
}

export function getCareChatLimitForUser(user) {
  if (computeUserIsPro(user)) return null;
  return isGuestUser(user) ? GUEST_CHAT_LIMIT : REGISTERED_CHAT_LIMIT;
}

export function buildCareLimitConfig() {
  return {
    guest: GUEST_CHAT_LIMIT,
    registered: REGISTERED_CHAT_LIMIT,
    pro: null,
    proLabel: 'unlimited',
  };
}
