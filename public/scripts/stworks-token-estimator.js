export const BYTES_PER_TOKEN = 3.35;

export const TOKEN_ESTIMATOR = Object.freeze({
    id: 'stworks-utf8-estimate-v1',
    runtime: 'browser',
    accuracy: 'estimate',
    tokenIds: false,
});

const encoder = new TextEncoder();

/**
 * Temporary, model-independent fallback. Replace this module when the new
 * estimator is available, and change its id to invalidate cached estimates.
 * Keep the synchronous contract for legacy ST callers.
 * @param {string} text Text to estimate.
 * @returns {number} Estimated token count, not a model tokenizer result.
 */
export function estimateText(text) {
    if (typeof text !== 'string' || !text.length) return 0;
    return Math.ceil(encoder.encode(text).byteLength / BYTES_PER_TOKEN);
}

/**
 * Preserves the ST caller's per-message/full adjustment with estimated text
 * costs. Serialized fields are text only, not image/audio/tool billing.
 * @param {object[]|object} messages Chat messages.
 * @param {{model?: string, full?: boolean}} options Caller context.
 * @returns {number} Estimated message token count.
 */
export function estimateMessages(messages, { model = '', full = false } = {}) {
    const items = Array.isArray(messages) ? messages : [messages];
    let count = -1;
    for (const message of items) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
        // The original client counted each message in a separate request.
        count += 6;
        for (const [key, value] of Object.entries(message)) {
            count += estimateText(typeof value === 'string' ? value : JSON.stringify(value));
            if (key === 'name') count += 1;
        }
    }
    if (!full && model !== 'claude') count -= 2;
    return Math.max(0, count);
}
