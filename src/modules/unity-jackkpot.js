import { randomInt } from 'node:crypto';
import { createConsoleLogger } from '../common/logging.js';

const logger = createConsoleLogger();
export function selectUnityJackpot(pools, rules, choose = randomInt) {
    const definitions = [
        ['smallJackpot', 'small', 'SJ', rules.smallAmounts, rules.smallLevelRanges],
        ['mediumJackpot', 'medium', 'MJ', rules.mediumAmounts, rules.mediumLevelRanges],
        ['bigJackpot', 'big', 'BJ', rules.bigAmounts, rules.bigLevelRanges]
    ];
    const funded = definitions.map((definition, index) => {
        const [key, , , amounts, ranges] = definition;
        const valid = amounts.filter(amount => amount > 0 && amount <= (pools?.[key] || 0) &&
            ranges.some((min, i) => i % 2 === 0 && amount >= min && amount <= ranges[i + 1]));
        return { definition, minimum: rules.minimumPools[index], valid };
    }).filter(entry => pools?.[entry.definition[0]] >= entry.minimum && entry.valid.length);
    if (!funded.length) {
		logger.info(null, "Not enough funding");
		return null;
	
	}
    const { definition: [poolKey, jackpotType, type, , ranges], minimum, valid } = funded[choose(funded.length)];
    const amount = valid[choose(valid.length)];
    const levels = [1, 2, 3].filter(level => amount >= ranges[(level - 1) * 2] && amount <= ranges[(level - 1) * 2 + 1]);
    const award = {
		poolKey,
		type,
		amount,
		isJackpot: true,
		jackpotType,
		jackpotAmount: amount,
        MinJackpotAmount: minimum,
		jackpotLevel: rules.theme === 'Golf' ? 1 : levels[choose(levels.length)] };
    if (rules.theme !== 'SevenSlot' || rules.governmentBuild) {
		
		return award;
	
	}
    const roll = choose(100);
	logger.debug(roll,"Rndom roll");
    award.eventType = roll < 80 ? 'hint' : roll < 90 ? 'no_hint' : 'all_fruit';
    // award.eventType = 'all_fruit';// testing only...
    if (award.eventType === 'all_fruit') {
        const variants = [['Cherry', 50000], ['Bell', 100000], ['Seven', 200000]];
        const [variant, payout] = variants[choose(variants.length)];
        Object.assign(award, { variant, amount: payout, jackpotAmount: payout });
    }
	logger.info(award,`Current Jp Award ${award.eventType}`);
    return award;
}
