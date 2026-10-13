import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';
import { settingsSchema } from '../common/validation.js';

const schema = new mongoose.Schema({
    storeId: {
		type: String,
		required: true
	},
    machineId: { type: String, required: true },
    gameId: { type: String, required: true },
    version: { type: Number, required: true, validate: safeInteger, min: 1 },
    settings: {
		type: mongoose.Schema.Types.Mixed,
		required: true,
        validate: value => settingsSchema.safeParse(value).success 
	
	},
    actorId: String,
    reason: String
}, { collection: 'machineSettings', timestamps: true, versionKey: false, strict: true });


schema.index({ storeId: 1, machineId: 1, gameId: 1 }, { unique: true });
validateWrites(schema);


const MachineSettings = mongoose.models.MachineSettings || mongoose.model('MachineSettings', schema);
export default MachineSettings;
