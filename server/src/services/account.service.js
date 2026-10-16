import Account from '../models/Account.js';
import { generateUniqueAccountNumber } from '../utils/generateAccountNumber.js';

/**
 * Creates the user's primary account. Called once, right after email
 * verification succeeds — never at registration time, since an account
 * shouldn't exist until identity is confirmed.
 */
export async function createAccountForUser(userId, session) {
  let accountQuery = Account.findOne({ user: userId });
  if (session) accountQuery = accountQuery.session(session);
  let account = await accountQuery;

  if (account) {
    if (/^1\d{8}$/.test(account.accountNumber || '')) return account;

    const accountNumber = await generateUniqueAccountNumber();
    const filter = { _id: account._id };
    if (account.accountNumber === undefined) {
      filter.accountNumber = { $exists: false };
    } else {
      filter.accountNumber = account.accountNumber;
    }
    const options = { new: true, runValidators: true };
    if (session) options.session = session;
    const repaired = await Account.findOneAndUpdate(
      filter,
      { $set: { accountNumber } },
      options
    );
    if (repaired) return repaired;

    accountQuery = Account.findOne({ user: userId });
    if (session) accountQuery = accountQuery.session(session);
    account = await accountQuery;
    if (account && /^1\d{8}$/.test(account.accountNumber || '')) return account;
    if (!account) return createAccountForUser(userId, session);
    throw new Error('Unable to repair account number.');
  }

  const newAccount = new Account({
    user: userId,
    accountNumber: await generateUniqueAccountNumber(),
    baseCurrency: 'USD',
    balance: 0,
    status: 'ACTIVE',
  });

  try {
    return await newAccount.save(session ? { session } : undefined);
  } catch (error) {
    if (session || error.code !== 11000) throw error;
    account = await Account.findOne({ user: userId });
    if (account) return createAccountForUser(userId);
    throw error;
  }
}

export async function getAccountByUserId(userId) {
  return Account.findOne({ user: userId });
}

export async function getAccountByNumber(accountNumber) {
  return Account.findOne({ accountNumber }).populate('user', 'firstName lastName status');
}
