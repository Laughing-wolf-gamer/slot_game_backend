import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String, default:null },
	storeId: { type: String, required: true },
	action: { type: String, required: true },
	actorId: { type: String },
	gameId: { type: String },
	machineId: { type: String },
	cardId: String,
	kioskId: String,
	sourceId: String,
	success: Boolean,
	eventId: { type: String },
	correlationId: { type: String },
	reason: { type: String },
	targetId: { type: String },
	stateVersion: { type: Number, validate: safeInteger, min: 0 },
	commandId: { type: String },
	awardId: { type: String },
	candidates: { type: [mongoose.Schema.Types.Mixed], default: undefined }
}, {
	collection: 'audit',
	timestamps:true,
	versionKey: false,
	strict: false,
	minimize: false,
	autoCreate: false,
	autoIndex: false,
});

schema.index({"storeId":1,"createdAt":-1}, {});

validateWrites(schema);

const Audit = mongoose.models.Audit || mongoose.model('Audit', schema);
export default Audit;
