const snapshotFields = new Set([
	'jackpotType', 'eventType', 'eventId', 'variant', 'timestamp', 'username',
	'idNumber', 'winning', 'bank', 'deposit', 'remainingTime', 'isJackpot',
	'isJackpotStatus', 'freespinwinamount', 'freespinRecievedAmount'
]);

export function normalizeLegacyGameUpdate(payload) {
	if (payload.deposit === undefined && payload.bank === undefined){
		return { ...payload };
	
	}
	const result = Object.fromEntries(Object.entries(payload).filter(([key]) => !snapshotFields.has(key)));
	result.credit = payload.deposit;
	result.bank = payload.bank;
	return result;
}
