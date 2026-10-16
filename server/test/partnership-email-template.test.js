import assert from 'node:assert/strict';
import process from 'node:process';
import { it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1/not-used';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.JWT_ADMIN_SECRET = 'test-admin-secret';
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_PASSWORD_HASH = 'unused-test-hash';

const { default: PartnershipEmailTemplate } = await import('../src/models/PartnershipEmailTemplate.js');
const { getPartnershipEmailIntro, savePartnershipEmailIntro } = await import('../src/services/admin.service.js');
const { sendPartnershipPaymentEmail, sendVerificationEmail } = await import('../src/services/email.service.js');
const { default: env } = await import('../src/config/env.js');

it('saves and renders the partnership intro without changing other email templates', async () => {
  const originalFindOneAndUpdate = PartnershipEmailTemplate.findOneAndUpdate;
  const originalFetch = globalThis.fetch;
  const originalApiKey = env.resend.apiKey;
  let storedTemplate;
  const sentMessages = [];

  PartnershipEmailTemplate.findOneAndUpdate = async (filter, update) => {
    if (!storedTemplate) {
      storedTemplate = { key: filter.key, ...(update.$setOnInsert || {}) };
    }
    Object.assign(storedTemplate, update.$set || {});
    return { ...storedTemplate };
  };
  env.resend.apiKey = 'mock-resend-key';
  globalThis.fetch = async (_url, options) => {
    sentMessages.push(JSON.parse(options.body));
    return { ok: true };
  };

  try {
    const originalIntro = await getPartnershipEmailIntro();
    assert.match(originalIntro, /We are pleased to confirm the details of our partnership/);

    const customIntro = 'A saved <partnership> introduction.';
    assert.equal(await savePartnershipEmailIntro(customIntro), customIntro);
    const persistedIntro = await getPartnershipEmailIntro();
    assert.equal(persistedIntro, customIntro);

    await sendPartnershipPaymentEmail({
      to: 'partner@example.test',
      recipientName: 'Jordan Lee',
      amount: '250.00',
      currency: 'USD',
      purpose: 'Creative partnership',
      depositDate: 'October 16, 2026',
      paymentMethod: 'Direct transfer',
      partnershipIntro: persistedIntro,
    });
    assert.match(sentMessages[0].html, /A saved &lt;partnership&gt; introduction\./);
    assert.match(sentMessages[0].html, /I’m reaching out on behalf of the/);
    assert.match(sentMessages[0].html, /\$250\.00/);
    assert.match(sentMessages[0].html, /Creative partnership/);
    assert.match(sentMessages[0].html, /October 16, 2026/);

    await sendVerificationEmail({
      to: 'user@example.test',
      firstName: 'Jordan',
      otp: '123456',
      expiresMinutes: 10,
    });
    assert.match(sentMessages[1].html, /Your verification code is:/);
    assert.doesNotMatch(sentMessages[1].html, /A saved/);
  } finally {
    PartnershipEmailTemplate.findOneAndUpdate = originalFindOneAndUpdate;
    globalThis.fetch = originalFetch;
    env.resend.apiKey = originalApiKey;
  }
});