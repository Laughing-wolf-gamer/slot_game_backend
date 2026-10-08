import mongoose from 'mongoose';
import { validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	deviceId: { type: String, required: true },
	role: { type: String, required: true },
	secretHash: { type: String, required: true },
	status: { type: String, required: true },
	machineId: { type: String },
	gameId: { type: String },
	installationId: { type: String },
	kioskId: { type: String },
	reason: { type: String },
	revokedAt: { type: Date }
}, { collection: 'devices',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"deviceId":1}, {"unique":true});
schema.index({"storeId":1,"installationId":1}, {"unique":true,"partialFilterExpression":{"role":"GAME_CLIENT"}});
schema.index({"storeId":1,"machineId":1}, {"unique":true,"partialFilterExpression":{"role":"DEVICE_TAS_C"}});
schema.index({"storeId":1,"kioskId":1}, {"unique":true,"partialFilterExpression":{"role":"DEVICE_TAS_K"}});

validateWrites(schema);

const Device = mongoose.models.Device || mongoose.model('Device', schema);
export default Device;
