import mongoose from 'mongoose';
import { validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	socketId: { type: String, required: true },
	actorId: { type: String, required: true },
	sourceId: { type: String, required: true },
	role: { type: String, required: true },
	machineId: { type: String },
	gameId: { type: String },
	installationId: { type: String },
	connected: { type: Boolean, required: true },
	lastSeenAt: { type: Date, required: true }
	
}, {collection: 'presence',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"createdAt":-1}, {});

validateWrites(schema);

const Presence = mongoose.models.Presence || mongoose.model('Presence', schema);
export default Presence;
