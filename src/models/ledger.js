import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	gameId: { type: String },
	machineId: { type: String },
	periodId: { type: String, required: true },
	eventId: { type: String, required: true },
	actorId: { type: String, required: true },
	type: { type: String, required: true },
	amount: { type: Number, required: true, validate: safeInteger },
	cardId: { type: String },
	cardDelta: {
		type: Number,
		validate: safeInteger
	},
	sessionId: { type: String },
	awardId: { type: String },
	kioskId: { type: String },
	billId: { type: String },
	balanceAfter: { type: Number, validate: safeInteger, min: 0 },
	transactionMethod: { type: String, enum: ['CASH', 'CARD', 'OTHER'] },
	validationSuccessCount: { type: Number, validate: safeInteger, min: 0 },
	cashInjectionData: { denomination: { type: Number, validate: safeInteger, min: 0 }, count: { type: Number, validate: safeInteger, min: 1 } },
	cardName: String,
	seconds: { type: Number, validate: safeInteger },
	reason: { type: String },
	credit: { type: Number, validate: safeInteger },
	bank: { type: Number, validate: safeInteger },
	commission: { type: Number, validate: safeInteger },
	
	allFruit: { type: mongoose.Schema.Types.Mixed }

}, { collection: 'ledger',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"createdAt":-1}, {});
schema.index({"storeId":1,"periodId":1,"gameId":1}, {});

validateWrites(schema);

const Ledger = mongoose.models.Ledger || mongoose.model('Ledger', schema);
export default Ledger;
