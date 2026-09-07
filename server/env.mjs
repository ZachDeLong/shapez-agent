/**
 * Reads an optional integer environment setting with explicit bounds.
 * Empty values preserve the documented default; malformed values fail before
 * a server starts or an agent run consumes them.
 */
export function readIntegerEnv(name, rawValue, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const text = rawValue?.trim();
    if (!text) return defaultValue;

    if (!/^\d+$/.test(text)) {
        throw new Error(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(rawValue)}`);
    }

    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(rawValue)}`);
    }
    return value;
}
