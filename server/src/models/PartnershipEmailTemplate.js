import mongoose from 'mongoose';
import { DEFAULT_PARTNERSHIP_INTRO } from '../config/emailTemplates.js';

const partnershipEmailTemplateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  intro: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500,
    default: DEFAULT_PARTNERSHIP_INTRO,
  },
});

export default mongoose.model('PartnershipEmailTemplate', partnershipEmailTemplateSchema);