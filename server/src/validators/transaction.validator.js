import { body, query } from 'express-validator';

export const transferValidator = [
  body('recipientAccountNumber')
    .trim()
    .matches(/^\d{9,10}$/)
    .withMessage('Account number must be 9 or 10 digits.'),
  body('recipientName')
    .optional()
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('Recipient name must be between 2 and 120 characters.'),
  body('idempotencyKey')
    .notEmpty()
    .withMessage('Transfer request key is required.')
    .trim()
    .isLength({ min: 8, max: 100 })
    .withMessage('Invalid transfer request key.'),
  body('amount')
    .isFloat({ gt: 0 })
    .withMessage('Amount must be greater than zero.'),
  body('currency')
    .isIn(['USD', 'EUR', 'GBP', 'NGN', 'CAD', 'AUD'])
    .withMessage('Unsupported currency.'),
  body('description').optional().trim().isLength({ max: 200 }).withMessage('Description is too long.'),
  body('transactionPin')
    .isLength({ min: 4, max: 4 })
    .withMessage('Enter your 4-digit transaction PIN.')
    .isNumeric()
    .withMessage('PIN must be numeric.'),
];

export const listTransactionsValidator = [
  query('type')
    .optional()
    .isIn(['ALL', 'CREDIT', 'DEBIT', 'TRANSFER'])
    .withMessage('Invalid transaction filter.'),
];
