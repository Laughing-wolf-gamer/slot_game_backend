import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	machineId: { type: String, required: true },
	machineNumber: { type: Number, required: true, validate: safeInteger, min: 0 },
	feePlan: { type: Number, validate: safeInteger, min: 0 },
	timeStatus: { type: String, required: true },
	remainingSeconds: { type: Number, validate: safeInteger, min: 0 },
	deadline: { type: Date,  },
	cardId: { type: String },
	stateVersion: { type: Number, required: true, validate: safeInteger, min: 0 },
	reason: { type: String, default:"Exited" }
  	
}, { collection: 'machines',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"machineId":1}, {"unique":true});
schema.index({"storeId":1,"machineNumber":1}, {"unique":true});

schema.path('deadline').required(function () { 
	return this.timeStatus === 'ACTIVE'; 
}, 'ACTIVE machines require a deadline');

validateWrites(schema);

const Machine = mongoose.models.Machine || mongoose.model('Machine', schema);
export default Machine;
