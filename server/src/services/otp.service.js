import bcrypt from 'bcrypt';
import Otp from '../models/Otp.js';
import env from '../config/env.js';
import { generateOtpCode } from '../utils/generateOtp.js';
import AppError from '../utils/AppError.js';

/**
 * Creates a new OTP for the given user/purpose. Any previous unused OTPs
 * for that same purpose are invalidated first, so only the most recent
 * code is ever valid (prevents an old, leaked code from still working).
 */
export async function createOtp(userId, purpose) {
  await Otp.updateMany({ user: userId, purpose, consumed: false }, { consumed: true });

  const code = generateOtpCode();
  const otpHash = await bcrypt.hash(code, env.bcryptSaltRounds);
  const expiresAt = new Date(Date.now() + env.otp.expiresMinutes * 60 * 1000);

  await Otp.create({ user: userId, otpHash, purpose, expiresAt });

  return { code, expiresMinutes: env.otp.expiresMinutes };
}

/**
 * Verifies a submitted OTP code. Consumes the record on success so it
 * cannot be replayed. Tracks attempts to prevent brute-forcing 6-digit
 * codes via repeated guesses against a single OTP record.
 */
export async function verifyOtp(userId, purpose, submittedCode, { session } = {}) {
  let query = Otp.findOne({ user: userId, purpose, consumed: false }).sort({ createdAt: -1 });
  if (session) query = query.session(session);
  const otp = await query;

  if (!otp) {
    throw new AppError('No active verification code found. Please request a new one.', 400);
  }

  if (otp.expiresAt <= new Date()) {
    throw new AppError('This code has expired. Please request a new one.', 400);
  }

  if (otp.attempts >= 5) {
    throw new AppError('Too many incorrect attempts. Please request a new code.', 429);
  }

  const isMatch = await bcrypt.compare(submittedCode, otp.otpHash);
  if (!isMatch) {
    const now = new Date();
    const update = await Otp.updateOne(
      { _id: otp._id, consumed: false, expiresAt: { $gt: now }, attempts: { $lt: 5 } },
      { $inc: { attempts: 1 } }
    );
    if (!update.matchedCount) await throwOtpStateError(otp._id);
    throw new AppError('That code is incorrect.', 400);
  }

  const options = { new: true };
  if (session) options.session = session;
  const consumed = await Otp.findOneAndUpdate(
    { _id: otp._id, consumed: false, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } },
    { $set: { consumed: true } },
    options
  );
  if (!consumed) await throwOtpStateError(otp._id);
  return true;
}

async function throwOtpStateError(otpId) {
  const otp = await Otp.findById(otpId).select('consumed expiresAt attempts');
  if (!otp || otp.consumed) {
    throw new AppError('No active verification code found. Please request a new one.', 400);
  }
  if (otp.expiresAt <= new Date()) {
    throw new AppError('This code has expired. Please request a new one.', 400);
  }
  if (otp.attempts >= 5) {
    throw new AppError('Too many incorrect attempts. Please request a new code.', 429);
  }
  throw new AppError('No active verification code found. Please request a new one.', 400);
}
