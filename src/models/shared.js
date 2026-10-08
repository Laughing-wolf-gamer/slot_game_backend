export const safeInteger = {
	
	validator: value => value == null || Number.isSafeInteger(value),
	message: 'Expected a safe integer'
};

export function validateWrites(schema) {
	for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne']) {
		schema.pre(operation, function () {

			this.setOptions({ runValidators: true });
		
		});
	}
}
