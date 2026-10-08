import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	type: { type: String, required: true },
	payload: { type: mongoose.Schema.Types.Mixed, required: true },
	status: { type: String, required: true },
	attempts: { type: Number, required: true, validate: safeInteger, min: 0 },
	deliveredAt: { type: Date },
	nextAttemptAt: { type: Date }
}, { collection: 'hqOutbox',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"createdAt":-1}, {});

validateWrites(schema);

const HqOutbox= mongoose.models.HqOutbox || mongoose.model('HqOutbox', schema);
export default HqOutbox;
