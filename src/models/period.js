import mongoose from 'mongoose';
import { validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	periodId: { type: String, required: true },
	status: { type: String, required: true },
	openedAt: { type: Date, required: true },
	closedAt: { type: Date },
	totals: {
		type: mongoose.Schema.Types.Mixed,
	},
	checksum: { type: String },
	actorId: { type: String },
	reason: { type: String }
}, { collection: 'periods',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"periodId":1}, {"unique":true});
schema.index({"storeId":1}, {"unique":true,"partialFilterExpression":{"status":"OPEN"}});

validateWrites(schema);

const Period =  mongoose.models.Period || mongoose.model('Period', schema);
export default Period;
