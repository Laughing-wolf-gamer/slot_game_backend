import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	sourceId: { type: String, required: true },
	eventId: { type: String, required: true },
	fingerprint: { type: String, required: true },
	result: { type: new mongoose.Schema({

		ok: { type: Boolean, required: true },
		eventId: { type: String, required: true },
		serverSequence: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0 },
		serverTime: { type: String, required: true },
		stateVersion: { type: Number, validate: safeInteger, min: 0 },
		data: { type: mongoose.Schema.Types.Mixed },
		error: { type: mongoose.Schema.Types.Mixed }


	}, { _id: false, strict: false, minimize: false }), required: true }
}, { collection: 'inbox',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"sourceId":1,"eventId":1}, {"unique":true});

validateWrites(schema);
const Inbox = mongoose.models.Inbox || mongoose.model('Inbox', schema);
export default Inbox;

