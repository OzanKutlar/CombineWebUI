/**
 * Normalized Multi-Curve and Triple Activity Heatmap Engine.
 * 
 * - 'area': 3 distinct smooth Bézier waves (Input, Output, Cost), each normalized to 0-100% of its own peak.
 * - 'spline': 3 smooth glowing curves with data nodes and crosshair tracking, each independently normalized.
 * - 'heatmap': 3 separate activity calendar grids (Input Tokens, Output Tokens, Estimated Cost).
 */

const MAX_BUCKETS = 120;
const PAD = { left: 62, right: 48, top: 22, bottom: 42 };
const NICE_STEPS = [1, 2, 2.5, 5, 10];
const GRID_LINES = 4;
const MIN_LABEL_SPACING = 58;

export function formatCompact(value) {
    const v = Number(value) || 0;
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
}

function niceMax(value) {
    if (!(value > 0)) return 1;
    const exp = Math.floor(Math.log10(value));
    const base = Math.pow(10, exp);
    const frac = value / base;
    for (let i = 0; i < NICE_STEPS.length; i++) {
        if (frac <= NICE_STEPS[i]) return NICE_STEPS[i] * base;
    }
    return 10 * base;
}

function escapeText(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderEmpty(container, message) {
    const empty = document.createElement('div');
    empty.className = 'tc-empty';
    empty.textContent = message;
    container.appendChild(empty);
}

function buildLegend(items) {
    const legend = document.createElement('div');
    legend.className = 'tc-legend';
    items.forEach(s => {
        const item = document.createElement('span');
        item.className = 'tc-legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'tc-legend-swatch';
        swatch.style.backgroundColor = s.color;
        if (s.isLine) {
            swatch.style.height = '3px';
            swatch.style.width = '14px';
            swatch.style.borderRadius = '2px';
        }
        item.appendChild(swatch);
        const label = document.createElement('span');
        label.textContent = s.name;
        item.appendChild(label);
        legend.appendChild(item);
    });
    return legend;
}

/** Generates smooth cubic Bézier SVG path data through coordinate points */
function buildSplinePath(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    
    let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;

        d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
}

/** Builds a single Calendar Heatmap SVG instance for a given metric */
function buildSingleHeatmapSvg(title, dates, bucketMap, metricKey, rampColors, width, formatVal) {
    let maxVal = 0;
    bucketMap.forEach(info => {
        const val = Number(info[metricKey]) || 0;
        if (val > maxVal) maxVal = val;
    });

    const cellSize = Math.max(10, Math.min(15, (width - 60) / 22));
    const cellGap = 3;
    const height = (cellSize + cellGap) * 7 + 34;

    const parts = [];
    parts.push(`<div class="tc-heatmap-section">`);
    parts.push(`
        <div class="flex items-center justify-between gap-2 border-b border-gb-bgLight2 pb-1.5">
            <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full" style="background-color:${rampColors[4]}"></span>
                <span class="text-xs font-bold text-gb-fgLightest uppercase tracking-wide">${title}</span>
            </div>
            <span class="text-[11px] font-mono text-gb-fgDark">Peak: <b style="color:${rampColors[4]}">${formatVal(maxVal)}</b></span>
        </div>
    `);

    parts.push(`<svg class="tc-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);

    const dowNames = ['M', '', 'W', '', 'F', '', 'S'];
    for (let row = 0; row < 7; row++) {
        const y = 14 + row * (cellSize + cellGap) + cellSize - 2;
        if (dowNames[row]) {
            parts.push(`<text class="tc-axis-label" x="14" y="${y}" text-anchor="middle">${dowNames[row]}</text>`);
        }
    }

    let col = 0;
    dates.forEach(date => {
        const dow = (date.getDay() + 6) % 7;
        const dateStr = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        const info = bucketMap.get(dateStr) || { input: 0, output: 0, cost: 0 };
        const val = Number(info[metricKey]) || 0;

        let color = rampColors[0];
        if (val > 0 && maxVal > 0) {
            const ratio = val / maxVal;
            if (ratio > 0.65) color = rampColors[4];
            else if (ratio > 0.35) color = rampColors[3];
            else if (ratio > 0.12) color = rampColors[2];
            else color = rampColors[1];
        }

        const x = 30 + col * (cellSize + cellGap);
        const y = 14 + dow * (cellSize + cellGap);

        parts.push(`<rect class="tc-heatmap-cell" data-metric="${metricKey}" data-title="${title}" data-date="${dateStr}" data-val="${val}" x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${color}"></rect>`);

        if (dow === 6) col++;
    });

    parts.push('</svg></div>');
    return parts.join('');
}

/** Renders 3 separate activity heatmaps for Input, Output, and Cost */
export function renderTripleCalendarHeatmaps(container, dailyBuckets, options) {
    container.innerHTML = '';
    if (!Array.isArray(dailyBuckets) || dailyBuckets.length === 0) {
        renderEmpty(container, options.emptyMessage || 'No activity recorded yet.');
        return;
    }

    const buckets = dailyBuckets.filter(b => b && b.date);
    if (buckets.length === 0) {
        renderEmpty(container, options.emptyMessage || 'No dated activity recorded.');
        return;
    }

    const pricing = options.pricing || {};
    const priceModels = (pricing && pricing.models) || {};

    const bucketMap = new Map();
    buckets.forEach(b => {
        let inT = 0, outT = 0, costT = 0;
        const models = b.models || {};
        Object.keys(models).forEach(k => {
            const mIn = Number(models[k].input) || 0;
            const mOut = Number(models[k].output) || 0;
            inT += mIn;
            outT += mOut;
            const p = priceModels[k];
            if (p) {
                costT += (mIn / 1000000) * (Number(p.input) || 0) + (mOut / 1000000) * (Number(p.output) || 0);
            }
        });
        bucketMap.set(b.date, { input: inT, output: outT, cost: costT });
    });

    const today = new Date();
    const days = 140;
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        dates.push(d);
    }

    const width = Math.max(340, container.clientWidth || 760);

    // 3 distinct color ramps
    const cyanRamp = ['rgba(var(--gb-bg-light-1), 0.45)', '#2d5e59', '#458588', '#68d3d8', '#74d2e7'];
    const limeRamp = ['rgba(var(--gb-bg-light-1), 0.45)', '#546e2a', '#79740e', '#98971a', '#b8bb26'];
    const amberRamp = ['rgba(var(--gb-bg-light-1), 0.45)', '#6e452a', '#af3a03', '#d79921', '#fabd2f'];

    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-4 w-full relative';

    const htmlIn = buildSingleHeatmapSvg('Input Tokens Heatmap', dates, bucketMap, 'input', cyanRamp, width, v => v.toLocaleString());
    const htmlOut = buildSingleHeatmapSvg('Output Tokens Heatmap', dates, bucketMap, 'output', limeRamp, width, v => v.toLocaleString());
    const htmlCost = buildSingleHeatmapSvg('Estimated Cost Heatmap', dates, bucketMap, 'cost', amberRamp, width, v => options.formatCost ? options.formatCost(v) : '$' + v.toFixed(3));

    wrap.innerHTML = htmlIn + htmlOut + htmlCost;

    const tooltip = document.createElement('div');
    tooltip.className = 'tc-chart-tooltip';
    tooltip.style.display = 'none';
    wrap.appendChild(tooltip);

    wrap.addEventListener('mousemove', (e) => {
        const cell = e.target.closest('.tc-heatmap-cell');
        if (!cell) {
            tooltip.style.display = 'none';
            return;
        }
        const title = cell.getAttribute('data-title');
        const d = cell.getAttribute('data-date');
        const val = Number(cell.getAttribute('data-val')) || 0;
        const mKey = cell.getAttribute('data-metric');

        let valStr = val.toLocaleString();
        if (mKey === 'cost') {
            valStr = options.formatCost ? options.formatCost(val) : '$' + val.toFixed(4);
        }

        tooltip.innerHTML = `
            <div class="tc-tip-title">${d}</div>
            <div class="tc-tip-row"><span>${title}:</span><span class="tc-tip-value font-bold">${valStr}</span></div>
        `;

        const rect = wrap.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        tooltip.style.display = 'block';
        const tipW = tooltip.offsetWidth || 160;
        tooltip.style.left = Math.max(4, Math.min(localX + 14, rect.width - tipW - 4)) + 'px';
        tooltip.style.top = Math.max(4, localY - 14) + 'px';
    });

    wrap.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    container.appendChild(wrap);
}

/**
 * Normalized Multi-Curve and Area Graph Renderer.
 * Normalizes each series (Input Tokens, Output Tokens, Cost) to 0-100% of its own peak.
 */
export function renderBarChart(container, options) {
    if (!container) return;
    const opts = options || {};
    const chartType = opts.type || 'area';

    if (chartType === 'heatmap') {
        renderTripleCalendarHeatmaps(container, opts.dailyRaw, opts);
        return;
    }

    container.innerHTML = '';

    let labels = Array.isArray(opts.labels) ? opts.labels : [];
    let inValues = Array.isArray(opts.series?.[0]?.values) ? opts.series[0].values : [];
    let outValues = Array.isArray(opts.series?.[1]?.values) ? opts.series[1].values : [];
    let costValues = Array.isArray(opts.costSeries?.values) ? opts.costSeries.values : [];

    if (labels.length === 0 || inValues.length === 0) {
        renderEmpty(container, opts.emptyMessage || 'No usage recorded in this window.');
        return;
    }

    if (labels.length > MAX_BUCKETS) {
        const start = labels.length - MAX_BUCKETS;
        labels = labels.slice(start);
        inValues = inValues.slice(start);
        outValues = outValues.slice(start);
        costValues = costValues.slice(start);
    }

    const count = labels.length;

    // 1. Calculate Peak Maxima for each metric
    let maxIn = 0, maxOut = 0, maxCost = 0;
    for (let i = 0; i < count; i++) {
        const iv = Number(inValues[i]) || 0;
        const ov = Number(outValues[i]) || 0;
        const cv = Number(costValues[i]) || 0;
        if (iv > maxIn) maxIn = iv;
        if (ov > maxOut) maxOut = ov;
        if (cv > maxCost) maxCost = cv;
    }

    if (maxIn <= 0 && maxOut <= 0 && maxCost <= 0) {
        renderEmpty(container, opts.emptyMessage || 'No usage recorded in this window.');
        return;
    }

    const width = Math.max(320, container.clientWidth || 760);
    const height = opts.height || 320;
    const plotW = Math.max(40, width - PAD.left - 24);
    const plotH = Math.max(40, height - PAD.top - PAD.bottom);
    const baseY = PAD.top + plotH;

    const groupW = plotW / Math.max(1, count);
    const xForCenter = (i) => PAD.left + groupW * i + groupW / 2;

    // Normalization Functions (0 -> baseY, Max -> PAD.top)
    const yNormIn = (v) => baseY - (maxIn > 0 ? ((Number(v) || 0) / maxIn) * plotH : 0);
    const yNormOut = (v) => baseY - (maxOut > 0 ? ((Number(v) || 0) / maxOut) * plotH : 0);
    const yNormCost = (v) => baseY - (maxCost > 0 ? ((Number(v) || 0) / maxCost) * plotH : 0);

    const parts = [];
    parts.push(`<svg class="tc-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`);

    // Gradient & Glow Filters
    parts.push(`
        <defs>
            <linearGradient id="tc-norm-grad-in" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#74d2e7" stop-opacity="0.35" />
                <stop offset="100%" stop-color="#74d2e7" stop-opacity="0.01" />
            </linearGradient>
            <linearGradient id="tc-norm-grad-out" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#b8bb26" stop-opacity="0.35" />
                <stop offset="100%" stop-color="#b8bb26" stop-opacity="0.01" />
            </linearGradient>
            <linearGradient id="tc-norm-grad-cost" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#fabd2f" stop-opacity="0.35" />
                <stop offset="100%" stop-color="#fabd2f" stop-opacity="0.01" />
            </linearGradient>
            <filter id="tc-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="2.5" result="blur" />
                <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                </feMerge>
            </filter>
        </defs>
    `);

    // Relative Percentage Grid Lines
    const gridTicks = [1.0, 0.75, 0.5, 0.25, 0.0];
    gridTicks.forEach(pct => {
        const y = PAD.top + (1.0 - pct) * plotH;
        parts.push(`<line class="tc-grid-line" x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${(PAD.left + plotW)}" y2="${y.toFixed(1)}"></line>`);
        const label = pct === 1.0 ? '100% (Peak)' : Math.round(pct * 100) + '%';
        parts.push(`<text class="tc-axis-label" x="${PAD.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${label}</text>`);
    });

    // Build Points for the 3 Normalized Curves
    const inPoints = [], outPoints = [], costPoints = [];
    for (let i = 0; i < count; i++) {
        const cx = xForCenter(i);
        inPoints.push({ x: cx, y: yNormIn(inValues[i]) });
        outPoints.push({ x: cx, y: yNormOut(outValues[i]) });
        costPoints.push({ x: cx, y: yNormCost(costValues[i]) });
    }

    if (chartType === 'area') {
        // Render 3 Overlapping Translucent Area Waves
        const makeAreaPath = (pts, fillId) => {
            let d = buildSplinePath(pts);
            d += ` L ${pts[pts.length - 1].x.toFixed(1)} ${baseY} L ${pts[0].x.toFixed(1)} ${baseY} Z`;
            return `<path d="${d}" fill="url(#${fillId})"></path>`;
        };

        parts.push(makeAreaPath(inPoints, 'tc-norm-grad-in'));
        parts.push(makeAreaPath(outPoints, 'tc-norm-grad-out'));
        if (maxCost > 0) parts.push(makeAreaPath(costPoints, 'tc-norm-grad-cost'));
    }

    // Render the 3 Normalized Spline Curves with Glowing Strokes
    parts.push(`<path d="${buildSplinePath(inPoints)}" fill="none" stroke="#74d2e7" stroke-width="2.5" filter="url(#tc-glow)"></path>`);
    parts.push(`<path d="${buildSplinePath(outPoints)}" fill="none" stroke="#b8bb26" stroke-width="2.5" filter="url(#tc-glow)"></path>`);
    if (maxCost > 0) {
        parts.push(`<path d="${buildSplinePath(costPoints)}" fill="none" stroke="#fabd2f" stroke-width="2.8" stroke-dasharray="4 3" filter="url(#tc-glow)"></path>`);
    }

    // Render Node Circles
    inPoints.forEach(p => parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#74d2e7" stroke="#1d2021" stroke-width="1.5"></circle>`));
    outPoints.forEach(p => parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#b8bb26" stroke="#1d2021" stroke-width="1.5"></circle>`));
    if (maxCost > 0) {
        costPoints.forEach(p => parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#fabd2f" stroke="#1d2021" stroke-width="1.5"></circle>`));
    }

    // Baseline
    parts.push(`<line class="tc-axis-line" x1="${PAD.left}" y1="${baseY}" x2="${(PAD.left + plotW)}" y2="${baseY}"></line>`);

    // X Axis Labels
    const labelStep = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotW / MIN_LABEL_SPACING))));
    for (let i = 0; i < count; i++) {
        if (i % labelStep !== 0 && i !== count - 1) continue;
        const center = xForCenter(i);
        parts.push(`<text class="tc-axis-label" x="${center.toFixed(1)}" y="${(baseY + 18)}" text-anchor="middle">${escapeText(labels[i])}</text>`);
    }

    // Hover Crosshair
    parts.push(`<line id="tc-crosshair" class="tc-crosshair-line hidden" x1="0" y1="${PAD.top}" x2="0" y2="${baseY}"></line>`);

    // Transparent Hover Hit Slices
    for (let i = 0; i < count; i++) {
        const x = PAD.left + groupW * i;
        parts.push(`<rect class="tc-bar-hit" data-idx="${i}" x="${x.toFixed(1)}" y="${PAD.top}" width="${groupW.toFixed(1)}" height="${plotH}"></rect>`);
    }

    parts.push('</svg>');

    // Enhanced Legend Showing Individual Peak Values
    const legendItems = [
        { name: `Input (Peak: ${formatCompact(maxIn)})`, color: '#74d2e7' },
        { name: `Output (Peak: ${formatCompact(maxOut)})`, color: '#b8bb26' }
    ];
    if (maxCost > 0) {
        const peakCostStr = opts.formatCost ? opts.formatCost(maxCost) : '$' + maxCost.toFixed(3);
        legendItems.push({ name: `Cost (Peak: ${peakCostStr})`, color: '#fabd2f', isLine: true });
    }
    container.appendChild(buildLegend(legendItems));

    const surface = document.createElement('div');
    surface.className = 'tc-chart-wrap';
    surface.innerHTML = parts.join('');

    const tooltip = document.createElement('div');
    tooltip.className = 'tc-chart-tooltip';
    tooltip.style.display = 'none';
    surface.appendChild(tooltip);

    const svg = surface.querySelector('svg');
    const crosshair = surface.querySelector('#tc-crosshair');

    if (svg) {
        svg.addEventListener('mousemove', (e) => {
            const hit = e.target.closest('.tc-bar-hit');
            if (!hit) {
                tooltip.style.display = 'none';
                if (crosshair) crosshair.classList.add('hidden');
                return;
            }
            const idx = Number(hit.getAttribute('data-idx'));
            if (!Number.isFinite(idx) || idx < 0 || idx >= count) {
                tooltip.style.display = 'none';
                if (crosshair) crosshair.classList.add('hidden');
                return;
            }

            const inVal = Number(inValues[idx]) || 0;
            const outVal = Number(outValues[idx]) || 0;
            const costVal = Number(costValues[idx]) || 0;

            const inPct = maxIn > 0 ? Math.round((inVal / maxIn) * 100) : 0;
            const outPct = maxOut > 0 ? Math.round((outVal / maxOut) * 100) : 0;
            const costPct = maxCost > 0 ? Math.round((costVal / maxCost) * 100) : 0;

            const lines = [`<div class="tc-tip-title">${escapeText(labels[idx])}</div>`];
            lines.push(`<div class="tc-tip-row"><span class="tc-legend-swatch" style="background-color:#74d2e7"></span><span>Input:</span><span class="tc-tip-value text-gb-blueAccent">${inVal.toLocaleString()} <span class="text-[10px] text-gb-fgDark font-normal">(${inPct}%)</span></span></div>`);
            lines.push(`<div class="tc-tip-row"><span class="tc-legend-swatch" style="background-color:#b8bb26"></span><span>Output:</span><span class="tc-tip-value text-gb-greenAccent">${outVal.toLocaleString()} <span class="text-[10px] text-gb-fgDark font-normal">(${outPct}%)</span></span></div>`);
            if (maxCost > 0) {
                const costStr = opts.formatCost ? opts.formatCost(costVal) : '$' + costVal.toFixed(3);
                lines.push(`<div class="tc-tip-row border-t border-gb-bgLight2 pt-1 mt-1"><span class="tc-legend-swatch" style="background-color:#fabd2f"></span><span>Est. Cost:</span><span class="tc-tip-value font-bold text-gb-yellowAccent">${costStr} <span class="text-[10px] text-gb-fgDark font-normal">(${costPct}%)</span></span></div>`);
            }
            tooltip.innerHTML = lines.join('');

            const rect = surface.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            const localY = e.clientY - rect.top;
            tooltip.style.display = 'block';

            const tipW = tooltip.offsetWidth || 180;
            const left = Math.max(4, Math.min(localX + 16, rect.width - tipW - 4));
            tooltip.style.left = left + 'px';
            tooltip.style.top = Math.max(4, localY - 14) + 'px';

            if (crosshair) {
                const cx = xForCenter(idx);
                crosshair.setAttribute('x1', cx.toFixed(1));
                crosshair.setAttribute('x2', cx.toFixed(1));
                crosshair.classList.remove('hidden');
            }
        });

        svg.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
            if (crosshair) crosshair.classList.add('hidden');
        });
    }

    container.appendChild(surface);
}
