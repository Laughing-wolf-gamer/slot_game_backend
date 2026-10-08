import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	awardId: { type: String, required: true },
	gameId: { type: String, required: true },
	machineId: { type: String, required: true },
	installationId: { type: String, required: true },
	sessionId: { type: String, required: true },
	type: { type: String, required: true },
	amount: { type: Number, required: true, validate: safeInteger, min: 0, max: 1000000000000 },
	status: { type: String, required: true },
	allFruit: { type: mongoose.Schema.Types.Mixed },
	completedAt: { type: Date },
	acknowledgedAt: { type: Date }
}, { collection: 'awards',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"awardId":1}, {"unique":true});

validateWrites(schema);
const Award = mongoose.models.Award || mongoose.model('Award', schema);
export default Award;
