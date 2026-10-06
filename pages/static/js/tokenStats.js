/**
 * Pure aggregation helpers for the token counter. No DOM access, so every
 * function here is independently testable and safe to call from any renderer.
 *
 * The backend hands over a date-bucketed `daily` array; everything the UI
 * needs for range filtering and trend charts is derived from it here rather
 * than round-tripping to the server on each tab switch.
 */

export const PRICE_UNIT = 1000000;

export const RANGE_KEYS = ['all', 'month', 'week'];

// Bounded windows, so a multi-year history can never produce an unreadable
// chart or an unbounded render loop.
export const GRANULARITY_LIMITS = {
    daily: 60,
    weekly: 16,
    monthly: 12
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

export function dayKeyFromDate(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

export function dateFromDayKey(key) {
    const parts = String(key || '').split('-');
    if (parts.length !== 3) return null;
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    return new Date(y, m - 1, d);
}

/** Weeks start on Monday. */
export function startOfWeekMonday(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return d;
}

/** Inclusive lower bound for a range, as a comparable YYYY-MM-DD key. */
export function rangeStartKey(rangeKey, now) {
    const ref = now || new Date();
    if (rangeKey === 'month') {
        return dayKeyFromDate(new Date(ref.getFullYear(), ref.getMonth(), 1));
    }
    if (rangeKey === 'week') {
        return dayKeyFromDate(startOfWeekMonday(ref));
    }
    return '';
}

export function rangeLabel(rangeKey) {
    if (rangeKey === 'month') return 'This month';
    if (rangeKey === 'week') return 'This week';
    return 'All time';
}

export function rangeNote(rangeKey, now) {
    const start = rangeStartKey(rangeKey, now);
    if (!start) return 'Every recorded turn';
    const d = dateFromDayKey(start);
    if (!d) return '';
    const label = MONTH_NAMES[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    return rangeKey === 'week'
        ? 'Since Monday ' + label
        : 'Since ' + label;
}

/** Day keys sort lexicographically, so a string compare is a date compare. */
export function filterDaily(daily, rangeKey, now) {
    if (!Array.isArray(daily)) return [];
    const start = rangeStartKey(rangeKey, now);
    if (!start) return daily.slice();
    return daily.filter(b => b && typeof b.date === 'string' && b.date >= start);
}

export function computeCost(inputTokens, outputTokens, price) {
    if (!price || typeof price !== 'object') return 0;
    const inRate = Number(price.input) || 0;
    const outRate = Number(price.output) || 0;
    const inTok = Number(inputTokens) || 0;
    const outTok = Number(outputTokens) || 0;
    return (inTok / PRICE_UNIT) * inRate + (outTok / PRICE_UNIT) * outRate;
}

/**
 * Folds a set of day buckets into per-model rows matching the shape the
 * all-time `by_model` payload already uses, so both feed the same renderer.
 */
export function aggregateModels(buckets, modelIndex, pricing) {
    const totals = new Map();

    (buckets || []).forEach(bucket => {
        const models = bucket && bucket.models;
        if (!models || typeof models !== 'object') return;
        Object.keys(models).forEach(modelId => {
            const row = models[modelId];
            if (!row) return;
            let agg = totals.get(modelId);
            if (!agg) {
                agg = { input: 0, output: 0, turns: 0, saved: 0 };
                totals.set(modelId, agg);
            }
            agg.input += Number(row.input) || 0;
            agg.output += Number(row.output) || 0;
            agg.turns += Number(row.turns) || 0;
            agg.saved += Number(row.saved) || 0;
        });
    });

    const priceModels = (pricing && pricing.models) || {};
    const index = modelIndex || {};
    const rows = [];

    totals.forEach((agg, modelId) => {
        const meta = index[modelId] || {};
        const price = priceModels[modelId];
        rows.push({
            model_id: modelId,
            provider_id: meta.provider_id || 'other',
            provider_name: meta.provider_name || 'Other',
            provider_logo: meta.provider_logo || '',
            input_tokens: agg.input,
            output_tokens: agg.output,
            total_tokens: agg.input + agg.output,
            saved_tokens: agg.saved,
            turns: agg.turns,
            cost: computeCost(agg.input, agg.output, price),
            has_price: Boolean(price)
        });
    });

    rows.sort((a, b) => b.total_tokens - a.total_tokens);
    return rows;
}

export function aggregateProviders(modelRows) {
    const map = new Map();

    (modelRows || []).forEach(row => {
        const id = row.provider_id || 'other';
        let prov = map.get(id);
        if (!prov) {
            prov = {
                provider_id: id,
                name: row.provider_name || 'Other',
                logo: row.provider_logo || '',
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                saved_tokens: 0,
                turns: 0,
                cost: 0,
                model_count: 0
            };
            map.set(id, prov);
        }
        if (!prov.logo && row.provider_logo) prov.logo = row.provider_logo;
        prov.input_tokens += row.input_tokens || 0;
        prov.output_tokens += row.output_tokens || 0;
        prov.total_tokens += row.total_tokens || 0;
        prov.saved_tokens += row.saved_tokens || 0;
        prov.turns += row.turns || 0;
        prov.cost += row.cost || 0;
        prov.model_count += 1;
    });

    const rows = Array.from(map.values());
    rows.sort((a, b) => b.total_tokens - a.total_tokens);
    return rows;
}

export function totalsFromRows(rows) {
    const totals = {
        input: 0,
        output: 0,
        total: 0,
        saved: 0,
        turns: 0,
        cost: 0,
        models: 0,
        priced: 0
    };

    (rows || []).forEach(row => {
        totals.input += row.input_tokens || 0;
        totals.output += row.output_tokens || 0;
        totals.saved += row.saved_tokens || 0;
        totals.turns += row.turns || 0;
        totals.cost += row.cost || 0;
        totals.models += 1;
        if (row.has_price) totals.priced += 1;
    });

    totals.total = totals.input + totals.output;
    return totals;
}

function periodKeyForDate(date, granularity) {
    if (granularity === 'monthly') {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
    }
    if (granularity === 'weekly') {
        return dayKeyFromDate(startOfWeekMonday(date));
    }
    return dayKeyFromDate(date);
}

function stepPeriod(date, granularity, delta) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (granularity === 'monthly') {
        d.setDate(1);
        d.setMonth(d.getMonth() + delta);
        return d;
    }
    if (granularity === 'weekly') {
        d.setDate(d.getDate() + delta * 7);
        return startOfWeekMonday(d);
    }
    d.setDate(d.getDate() + delta);
    return d;
}

function periodStart(date, granularity) {
    if (granularity === 'monthly') {
        return new Date(date.getFullYear(), date.getMonth(), 1);
    }
    if (granularity === 'weekly') {
        return startOfWeekMonday(date);
    }
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatPeriodLabel(date, granularity) {
    if (granularity === 'monthly') {
        return MONTH_NAMES[date.getMonth()] + ' ' + String(date.getFullYear()).slice(-2);
    }
    return MONTH_NAMES[date.getMonth()] + ' ' + date.getDate();
}

/**
 * Folds day buckets into a contiguous, gap-filled series ending today.
 *
 * The window walks backwards from the current period and stops at either the
 * granularity limit or the earliest bucket that actually holds data, so short
 * histories do not render a wall of empty columns.
 */
export function rollUp(daily, granularity, pricing) {
    const limit = GRANULARITY_LIMITS[granularity] || 30;
    const priceModels = (pricing && pricing.models) || {};
    const groups = new Map();
    let earliestKey = null;

    (daily || []).forEach(bucket => {
        const date = bucket && dateFromDayKey(bucket.date);
        if (!date) return;
        const key = periodKeyForDate(date, granularity);
        if (earliestKey === null || key < earliestKey) earliestKey = key;

        let group = groups.get(key);
        if (!group) {
            group = { input: 0, output: 0, turns: 0, saved: 0, cost: 0 };
            groups.set(key, group);
        }

        const models = bucket.models || {};
        Object.keys(models).forEach(modelId => {
            const row = models[modelId] || {};
            const inp = Number(row.input) || 0;
            const out = Number(row.output) || 0;
            group.input += inp;
            group.output += out;
            group.turns += Number(row.turns) || 0;
            group.saved += Number(row.saved) || 0;
            group.cost += computeCost(inp, out, priceModels[modelId]);
        });
    });

    if (groups.size === 0) return [];

    const window = [];
    let cursor = periodStart(new Date(), granularity);
    for (let i = 0; i < limit; i++) {
        const key = periodKeyForDate(cursor, granularity);
        window.push({ key, date: new Date(cursor) });
        if (earliestKey !== null && key <= earliestKey) break;
        cursor = stepPeriod(cursor, granularity, -1);
    }
    window.reverse();

    return window.map(entry => {
        const group = groups.get(entry.key) || { input: 0, output: 0, turns: 0, saved: 0, cost: 0 };
        return {
            key: entry.key,
            label: formatPeriodLabel(entry.date, granularity),
            input: group.input,
            output: group.output,
            turns: group.turns,
            saved: group.saved,
            cost: group.cost
        };
    });
}
