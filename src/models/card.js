import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	cardId: { type: String, required: true },
	cardUid: { type: String },
	displayNumber: { type: String },
	name: { type: String },
	kind: { type: String, enum: ['PLAYER', 'ADMIN'], default: 'PLAYER' },
	registeredAt: { type: Date },
	deletedAt: { type: Date },
	status: { type: String, required: true },
	points: { type: Number, required: true, validate: safeInteger, min: 0, max: 1000000000000 },
	timeMinutes: { type: Number, validate: safeInteger, min: 0, max: 1000000, default: 0 },
	stateVersion: { type: Number, required: true, validate: safeInteger, min: 0 },
	reason: { type: String }
	
}, { collection: 'cards',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"cardId":1}, {"unique":true});
schema.index({"storeId":1,"cardUid":1}, {"unique":true});

validateWrites(schema);

const Card = mongoose.models.Card || mongoose.model('Card', schema);
export default Card;
