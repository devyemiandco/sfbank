import mongoose from 'mongoose';
import Account from '../models/Account.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import { generateTransactionReference } from '../utils/generateReference.js';
import { verifyTransactionPin } from './pin.service.js';
import { createNotification } from './notification.service.js';
import {
  sendTransferSentEmail,
  sendTransferReceivedEmail,
} from './email.service.js';

function assertSameTransferRequest(existing, { amount, currency, recipientAccountNumber, recipientName, description }) {
  if (
    existing.amount !== amount
    || existing.currency !== currency
    || existing.counterpartyAccountNumber !== recipientAccountNumber
    || (existing.description || '') !== (description || '')
    || (existing.status === 'PENDING' && existing.counterpartyName !== recipientName?.trim())
  ) {
    throw new AppError('This transfer request key was already used for different details.', 409);
  }
}

export async function getTransactionsForAccount(accountId, { type } = {}) {
  const filter = { account: accountId };
  if (type && type !== 'ALL') {
    if (type === 'TRANSFER') filter.type = 'TRANSFER';
    else filter.direction = type; // CREDIT or DEBIT
  }
  return Transaction.find(filter).sort({ createdAt: -1 });
}

export async function getTransactionById(accountId, transactionId) {
  const tx = await Transaction.findOne({ _id: transactionId, account: accountId });
  if (!tx) throw new AppError('Transaction not found.', 404);
  return tx;
}

/**
 * Performs a peer-to-peer transfer atomically: both balances update and
 * both ledger entries are written, or none of it happens. Uses MongoDB
 * multi-document transactions (requires a replica set — Atlas's free tier
 * qualifies) rather than manual rollback logic, which is easy to get wrong
 * under concurrent requests.
 *
 * Order of operations matters here and follows the project's required flow:
 * validate everything BEFORE touching any balance. The PIN is checked before
 * the transaction even starts, so a wrong PIN never partially executes anything.
 */
export async function transferFunds({
  senderUserId,
  senderAccount,
  recipientAccountNumber,
  recipientName,
  amount,
  currency,
  description,
  transactionPin,
  idempotencyKey,
}) {
  // 1. PIN check happens first and outside the DB transaction — an incorrect
  //    PIN should never even open a transaction against the ledger.
  await verifyTransactionPin(senderUserId, transactionPin);

  // 2. Basic validation.
  if (amount <= 0) {
    throw new AppError('Transfer amount must be greater than zero.', 400);
  }
  if (currency !== senderAccount.baseCurrency) {
    // See project note: real fund movement only happens in the account's
    // base currency in V1. The currency selector on the frontend is a
    // display convenience; cross-currency transfers are a Phase 6+ feature
    // once a real exchange-rate provider is integrated.
    throw new AppError(
      `Transfers can currently only be made in ${senderAccount.baseCurrency}.`,
      400
    );
  }
  if (recipientAccountNumber === senderAccount.accountNumber) {
    throw new AppError('You cannot transfer money to your own account.', 400);
  }

  if (senderAccount.status !== 'ACTIVE') {
    throw new AppError('Your account is not active.', 403);
  }

  if (idempotencyKey) {
    const existing = await Transaction.findOne({ account: senderAccount._id, idempotencyKey });
    if (existing) {
      assertSameTransferRequest(existing, {
        amount, currency, recipientAccountNumber, recipientName, description,
      });
      const creditTransaction = existing.transferGroupId
        ? await Transaction.findOne({ transferGroupId: existing.transferGroupId, direction: 'CREDIT' })
        : null;
      return { debitTransaction: existing, creditTransaction };
    }
  }

  const recipientAccount = await Account.findOne({ accountNumber: recipientAccountNumber });
  if (!recipientAccount) {
    const normalizedRecipientName = recipientName?.trim();
    if (!normalizedRecipientName || normalizedRecipientName.length < 2 || normalizedRecipientName.length > 120) {
      throw new AppError('Enter the recipient account holder name.', 400);
    }
  } else if (recipientAccount.status !== 'ACTIVE') {
    throw new AppError('The recipient account is not active.', 400);
  }

  const session = await mongoose.startSession();
  let debitTx;
  let creditTx;
  let idempotentReplay = false;
  const transferGroupId = new mongoose.Types.ObjectId();

  try {
    await session.withTransaction(async () => {
      if (idempotencyKey) {
        const existing = await Transaction.findOne({ account: senderAccount._id, idempotencyKey }).session(session);
        if (existing) {
          assertSameTransferRequest(existing, {
            amount, currency, recipientAccountNumber, recipientName, description,
          });
          debitTx = existing;
          creditTx = existing.transferGroupId
            ? await Transaction.findOne({ transferGroupId: existing.transferGroupId, direction: 'CREDIT' }).session(session)
            : null;
          idempotentReplay = true;
          return;
        }
      }

      // Atomic guarded debit: the balance >= amount condition is checked
      // and applied in the same database operation, so two concurrent
      // transfers can never both pass a balance check that only one of
      // them should have passed (the classic race condition in transfers).
      const debitedSender = await Account.findOneAndUpdate(
        { _id: senderAccount._id, balance: { $gte: amount }, status: 'ACTIVE' },
        { $inc: { balance: -amount } },
        { new: true, session }
      );
      if (!debitedSender) {
        throw new AppError('Insufficient balance.', 400);
      }

      const senderUser = await User.findById(senderUserId).session(session);
      const isInternalTransfer = Boolean(recipientAccount);
      let recipientUser = null;

      if (isInternalTransfer) {
        const creditedRecipient = await Account.findOneAndUpdate(
          { _id: recipientAccount._id, status: 'ACTIVE' },
          { $inc: { balance: amount } },
          { new: true, session }
        );
        if (!creditedRecipient) throw new AppError('The recipient account is not active.', 400);
        recipientUser = await User.findById(recipientAccount.user).session(session);
      }

      const debitDocs = await Transaction.create(
        [{
          account: senderAccount._id,
          reference: generateTransactionReference(),
          direction: 'DEBIT',
          type: 'TRANSFER',
          amount,
          fee: 0,
          currency,
          status: isInternalTransfer ? 'COMPLETED' : 'PENDING',
          description,
          counterpartyAccountNumber: recipientAccountNumber,
          counterpartyName: isInternalTransfer
            ? `${recipientUser.firstName} ${recipientUser.lastName}`
            : recipientName.trim(),
          transferGroupId,
          idempotencyKey: idempotencyKey || null,
        }],
        { session }
      );
      debitTx = debitDocs[0];

      if (isInternalTransfer) {
        const creditDocs = await Transaction.create(
          [{
            account: recipientAccount._id,
            reference: generateTransactionReference(),
            direction: 'CREDIT',
            type: 'TRANSFER',
            amount,
            fee: 0,
            currency,
            status: 'COMPLETED',
            description,
            counterpartyAccountNumber: senderAccount.accountNumber,
            counterpartyName: `${senderUser.firstName} ${senderUser.lastName}`,
            transferGroupId,
          }],
          { session }
        );
        creditTx = creditDocs[0];
      }
    });
  } catch (error) {
    if (idempotencyKey && error.code === 11000) {
      const existing = await Transaction.findOne({ account: senderAccount._id, idempotencyKey });
      if (existing) {
        assertSameTransferRequest(existing, {
          amount, currency, recipientAccountNumber, recipientName, description,
        });
        const existingCredit = existing.transferGroupId
          ? await Transaction.findOne({ transferGroupId: existing.transferGroupId, direction: 'CREDIT' })
          : null;
        return { debitTransaction: existing, creditTransaction: existingCredit };
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }

  if (idempotentReplay) return { debitTransaction: debitTx, creditTransaction: creditTx };

  // 3. Side effects (email, in-app notifications) happen after the
  //    transaction has committed, and are never allowed to undo it — an
  //    email provider outage must not corrupt financial data (project rule).
  if (!recipientAccount) return { debitTransaction: debitTx, creditTransaction: null };

  const senderUser = await User.findById(senderUserId);
  const recipientUser = await User.findById(recipientAccount.user);

  await Promise.allSettled([
    createNotification({
      user: senderUserId,
      title: 'Transfer sent',
      body: `You sent ${currency} ${amount.toFixed(2)} to ${recipientUser.firstName} ${recipientUser.lastName}.`,
      relatedTransaction: debitTx._id,
    }),
    createNotification({
      user: recipientAccount.user,
      title: 'Transfer received',
      body: `You received ${currency} ${amount.toFixed(2)} from ${senderUser.firstName} ${senderUser.lastName}.`,
      relatedTransaction: creditTx._id,
    }),
    sendTransferSentEmail({
      to: senderUser.email,
      firstName: senderUser.firstName,
      amount: amount.toFixed(2),
      currency,
      recipientName: `${recipientUser.firstName} ${recipientUser.lastName}`,
    }),
    sendTransferReceivedEmail({
      to: recipientUser.email,
      firstName: recipientUser.firstName,
      amount: amount.toFixed(2),
      currency,
      senderName: `${senderUser.firstName} ${senderUser.lastName}`,
    }),
  ]);

  return { debitTransaction: debitTx, creditTransaction: creditTx };
}
