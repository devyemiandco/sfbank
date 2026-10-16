import assert from 'node:assert/strict';
import process from 'node:process';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcrypt';
import express from 'express';

const testMongoUri = process.env.SFB_TEST_MONGO_URI;
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = testMongoUri || 'mongodb://127.0.0.1/sfb-test-not-used';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.JWT_ADMIN_SECRET = 'test-admin-secret';
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_PASSWORD_HASH = 'unused-test-hash';

const mongoose = (await import('mongoose')).default;
const { default: User } = await import('../src/models/User.js');
const { default: Account } = await import('../src/models/Account.js');
const { default: Transaction } = await import('../src/models/Transaction.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { default: Notification } = await import('../src/models/Notification.js');
const { transferFunds } = await import('../src/services/transaction.service.js');
const { reversePendingTransfer } = await import('../src/services/admin.service.js');
const protectAdmin = (await import('../src/middleware/adminAuth.middleware.js')).default;
const { signAccessToken, signAdminToken } = await import('../src/utils/token.js');

async function clearTestRecords() {
  await Promise.all([
    Notification.deleteMany({}),
    AuditLog.deleteMany({}),
    Transaction.deleteMany({}),
    Account.deleteMany({}),
    User.deleteMany({}),
  ]);
}

async function seedAccounts(senderBalance = 100) {
  const pinHash = await bcrypt.hash('1234', 4);
  const sender = await User.create({
    firstName: 'Taylor',
    lastName: 'Sender',
    email: 'sender@example.test',
    phone: '1000000001',
    passwordHash: 'not-used',
    transactionPinHash: pinHash,
  });
  const senderAccount = await Account.create({
    user: sender._id,
    accountNumber: '111111111',
    baseCurrency: 'USD',
    balance: senderBalance,
  });
  const recipient = await User.create({
    firstName: 'Morgan',
    lastName: 'Recipient',
    email: 'recipient@example.test',
    phone: '1000000002',
    passwordHash: 'not-used',
    transactionPinHash: pinHash,
  });
  const recipientAccount = await Account.create({
    user: recipient._id,
    accountNumber: '122222222',
    baseCurrency: 'USD',
    balance: 10,
  });
  return { sender, senderAccount, recipientAccount };
}

function transferRequest({ sender, senderAccount, recipientAccountNumber, recipientName, amount = 10, idempotencyKey }) {
  return transferFunds({
    senderUserId: sender._id,
    senderAccount,
    recipientAccountNumber,
    recipientName,
    amount,
    currency: 'USD',
    description: 'Integration test transfer',
    transactionPin: '1234',
    idempotencyKey,
  });
}

describe('admin authorization', () => {
  it('rejects unauthenticated and user tokens and accepts the admin token', async () => {
    const app = express();
    app.get('/admin-only', protectAdmin, (req, res) => res.json({ email: req.admin.email }));
    app.use((error, _req, res, next) => {
      if (res.headersSent) return next(error);
      return res.status(error.statusCode || 500).json({ message: error.message });
    });
    const server = await new Promise((resolve) => {
      const listeningServer = app.listen(0, () => resolve(listeningServer));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/admin-only`;

    try {
      assert.equal((await globalThis.fetch(baseUrl)).status, 401);
      assert.equal((await globalThis.fetch(baseUrl, {
        headers: { authorization: `Bearer ${signAccessToken('user-id')}` },
      })).status, 401);
      const authorized = await globalThis.fetch(baseUrl, {
        headers: { authorization: `Bearer ${signAdminToken('admin@example.test')}` },
      });
      assert.equal(authorized.status, 200);
      assert.equal((await authorized.json()).email, 'admin@example.test');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe('MongoDB transfer integration', { skip: !testMongoUri && 'Set SFB_TEST_MONGO_URI to an isolated MongoDB replica set.' }, () => {
  before(async () => {
    await mongoose.connect(testMongoUri, {
      dbName: `sfb_transfer_test_${process.pid}_${Date.now()}`,
      serverSelectionTimeoutMS: 8000,
    });
    await Promise.all([User.init(), Account.init(), Transaction.init(), AuditLog.init()]);
  });

  beforeEach(clearTestRecords);
  afterEach(clearTestRecords);
  after(async () => {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  });

  it('completes an internal transfer with paired ledger entries', async () => {
    const { sender, senderAccount, recipientAccount } = await seedAccounts();
    const result = await transferRequest({
      sender,
      senderAccount,
      recipientAccountNumber: recipientAccount.accountNumber,
      amount: 15,
      idempotencyKey: 'test-internal-0001',
    });

    assert.equal(result.debitTransaction.status, 'COMPLETED');
    assert.equal((await Account.findById(senderAccount._id)).balance, 85);
    assert.equal((await Account.findById(recipientAccount._id)).balance, 25);
    assert.equal(await Transaction.countDocuments({ transferGroupId: result.debitTransaction.transferGroupId }), 2);
  });

  it('debits and records an unknown recipient as pending without a credit', async () => {
    const { sender, senderAccount } = await seedAccounts();
    const result = await transferRequest({
      sender,
      senderAccount,
      recipientAccountNumber: '133333333',
      recipientName: 'Jordan Example',
      amount: 15,
      idempotencyKey: 'test-pending-0001',
    });

    assert.equal(result.debitTransaction.status, 'PENDING');
    assert.equal(result.debitTransaction.counterpartyName, 'Jordan Example');
    assert.equal(result.debitTransaction.fee, 0);
    assert.equal(result.creditTransaction, null);
    assert.equal((await Account.findById(senderAccount._id)).balance, 85);
    assert.equal(await Account.countDocuments({ accountNumber: '133333333' }), 0);
  });

  it('does not debit when the sender has insufficient balance', async () => {
    const { sender, senderAccount } = await seedAccounts(5);
    await assert.rejects(transferRequest({
      sender,
      senderAccount,
      recipientAccountNumber: '133333333',
      recipientName: 'Jordan Example',
      amount: 10,
      idempotencyKey: 'test-insufficient-01',
    }), /Insufficient balance/);
    assert.equal((await Account.findById(senderAccount._id)).balance, 5);
    assert.equal(await Transaction.countDocuments(), 0);
  });

  it('does not debit when the PIN is invalid', async () => {
    const { sender, senderAccount } = await seedAccounts();
    await assert.rejects(transferFunds({
      senderUserId: sender._id,
      senderAccount,
      recipientAccountNumber: '133333333',
      recipientName: 'Jordan Example',
      amount: 10,
      currency: 'USD',
      transactionPin: '9999',
      idempotencyKey: 'test-invalid-pin-01',
    }), /Incorrect transaction PIN/);
    assert.equal((await Account.findById(senderAccount._id)).balance, 100);
    assert.equal(await Transaction.countDocuments(), 0);
  });

  it('returns the same transfer for concurrent requests with one idempotency key', async () => {
    const { sender, senderAccount } = await seedAccounts();
    const request = {
      sender,
      senderAccount,
      recipientAccountNumber: '133333333',
      recipientName: 'Jordan Example',
      amount: 10,
      idempotencyKey: 'test-concurrent-001',
    };
    const results = await Promise.all([transferRequest(request), transferRequest(request)]);

    assert.equal(results[0].debitTransaction._id.toString(), results[1].debitTransaction._id.toString());
    assert.equal((await Account.findById(senderAccount._id)).balance, 90);
    assert.equal(await Transaction.countDocuments({ direction: 'DEBIT' }), 1);
  });

  it('refunds and records a pending transfer reversal atomically', async () => {
    const { sender, senderAccount } = await seedAccounts();
    const pending = await transferRequest({
      sender,
      senderAccount,
      recipientAccountNumber: '133333333',
      recipientName: 'Jordan Example',
      amount: 10,
      idempotencyKey: 'test-reverse-0001',
    });
    const reversal = await reversePendingTransfer(pending.debitTransaction._id, 'admin@example.test');

    assert.equal((await Transaction.findById(pending.debitTransaction._id)).status, 'REVERSED');
    assert.equal((await Account.findById(senderAccount._id)).balance, 100);
    assert.equal(reversal.direction, 'CREDIT');
    assert.equal(reversal.amount, 10);
    assert.equal(await AuditLog.countDocuments({ action: 'TRANSFER_REVERSED' }), 1);
  });

  it('rejects duplicate and concurrent reversals without a second refund', async () => {
    const { sender, senderAccount } = await seedAccounts();
    const pending = await transferRequest({
      sender,
      senderAccount,
      recipientAccountNumber: '133333333',
      recipientName: 'Jordan Example',
      amount: 10,
      idempotencyKey: 'test-reverse-race-01',
    });
    const outcomes = await Promise.allSettled([
      reversePendingTransfer(pending.debitTransaction._id, 'admin@example.test'),
      reversePendingTransfer(pending.debitTransaction._id, 'admin@example.test'),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    await assert.rejects(reversePendingTransfer(pending.debitTransaction._id, 'admin@example.test'), /no longer pending/);
    assert.equal((await Account.findById(senderAccount._id)).balance, 100);
    assert.equal(await Transaction.countDocuments({ direction: 'CREDIT', status: 'COMPLETED' }), 1);
    assert.equal(await AuditLog.countDocuments({ action: 'TRANSFER_REVERSED' }), 1);
  });

  it('rolls back the status and refund when audit persistence fails', async () => {
    const { sender, senderAccount } = await seedAccounts();
    const pending = await transferRequest({
      sender,
      senderAccount,
      recipientAccountNumber: '133333333',
      recipientName: 'Jordan Example',
      amount: 10,
      idempotencyKey: 'test-rollback-0001',
    });
    const originalCreate = AuditLog.create;
    AuditLog.create = async () => { throw new Error('simulated audit failure'); };

    try {
      await assert.rejects(reversePendingTransfer(pending.debitTransaction._id, 'admin@example.test'), /simulated audit failure/);
    } finally {
      AuditLog.create = originalCreate;
    }

    assert.equal((await Transaction.findById(pending.debitTransaction._id)).status, 'PENDING');
    assert.equal((await Account.findById(senderAccount._id)).balance, 90);
    assert.equal(await Transaction.countDocuments({ direction: 'CREDIT' }), 0);
  });
});