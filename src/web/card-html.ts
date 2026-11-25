import { basename } from "node:path";
import type { CardChild, CardElement } from "chat";
import { type CardTone, splitCards, validateCard } from "../channel/card";
import { renderMarkdown } from "../dashboard/markdown";
import { esc } from "../dashboard/text";
import type { WebMessageRow } from "../store/web-messages";

type ChartChild = Extract<CardChild, { type: "chart" }>;

const CHART_COLORS = ["#58A6FF", "#2EB67D", "#ECB22E", "#F87171", "#A78BFA", "#2DD4BF", "#F97316", "#E879F9"];
const SAFE_HTTP_URL = /^https?:\/\/[^\s]+$/i;

function safeHref(url: string): string | undefined {
	return SAFE_HTTP_URL.test(url.trim()) ? url.trim() : undefined;
}

function niceTickValues(minVal: number, maxVal: number): { lo: number; hi: number; ticks: number[] } {
	let lo = Math.min(0, minVal);
	let hi = Math.max(0, maxVal);
	if (lo === hi) hi = lo === 0 ? 10 : lo + Math.abs(lo) * 0.2;
	const span = hi - lo;
	const step = 10 ** Math.floor(Math.log10(span)) || 1;
	const norm = span / step;
	const niceStep = norm <= 1.5 ? step * 0.25 : norm <= 3 ? step * 0.5 : norm <= 7 ? step : step * 2;
	lo = Math.floor(lo / niceStep) * niceStep;
	hi = Math.ceil(hi / niceStep) * niceStep;
	const ticks: number[] = [];
	for (let i = 0; i <= 4; i++) {
		ticks.push(Number((lo + ((hi - lo) * i) / 4).toFixed(4)));
	}
	return { lo, hi, ticks };
}

function formatAxisNumber(n: number): string {
	if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
	return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function renderPieChartSvg(element: ChartChild): string {
	const chart = element.chart;
	if (chart.type !== "pie") return "";
	const positive = chart.segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
	const total = positive.reduce((sum, s) => sum + s.value, 0);
	if (total <= 0) return '<p class="wc-muted">표시할 데이터가 없습니다</p>';

	const cx = 96;
	const cy = 96;
	const r = 74;
	const paths: string[] = [];
	const legend: string[] = [];
	let angle = -Math.PI / 2;

	for (const [idx, seg] of positive.entries()) {
		const color = CHART_COLORS[idx % CHART_COLORS.length] ?? "#58A6FF";
		const frac = seg.value / total;
		const pct = (frac * 100).toFixed(1);
		if (frac >= 0.9999) {
			paths.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
		} else {
			const next = angle + frac * Math.PI * 2;
			const x1 = cx + r * Math.cos(angle);
			const y1 = cy + r * Math.sin(angle);
			const x2 = cx + r * Math.cos(next);
			const y2 = cy + r * Math.sin(next);
			const large = frac > 0.5 ? 1 : 0;
			paths.push(
				`<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${color}" stroke="var(--c-surface)" stroke-width="1.5"><title>${esc(seg.label)}: ${esc(formatAxisNumber(seg.value))} (${pct}%)</title></path>`,
			);
			angle = next;
		}
		legend.push(
			`<li class="wc-chart-leg-item"><span class="wc-swatch" style="background:${color}"></span><span class="wc-leg-label">${esc(seg.label)}</span><span class="wc-leg-val">${esc(formatAxisNumber(seg.value))} (${pct}%)</span></li>`,
		);
	}

	return `<div class="wc-chart-wrap wc-chart-pie"><svg class="wc-chart-svg wc-pie-svg" viewBox="0 0 192 192" role="img" aria-label="${esc(element.title)}">${paths.join("")}</svg><ul class="wc-chart-leg">${legend.join("")}</ul></div>`;
}

function renderSeriesChartSvg(element: ChartChild): string {
	const chart = element.chart;
	if (chart.type === "pie") return renderPieChartSvg(element);
	const categories = chart.categories;
	const series = chart.series;
	if (categories.length === 0 || series.length === 0) return '<p class="wc-muted">표시할 데이터가 없습니다</p>';

	const allVals: number[] = [];
	for (const s of series) {
		for (const pt of s.data) {
			if (Number.isFinite(pt.value)) allVals.push(pt.value);
		}
	}
	const { lo, hi, ticks } = niceTickValues(
		allVals.length === 0 ? 0 : Math.min(...allVals),
		allVals.length === 0 ? 10 : Math.max(...allVals),
	);

	const width = 520;
	const height = 220;
	const padL = 52;
	const padR = 16;
	const padT = 16;
	const padB = 38;
	const plotW = width - padL - padR;
	const plotH = height - padT - padB;
	const range = hi - lo || 1;
	const yFor = (val: number): number => padT + plotH - ((val - lo) / range) * plotH;
	const zeroY = yFor(0);

	const gridAndTicks = ticks
		.map((val) => {
			const y = yFor(val);
			return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="var(--c-line)" stroke-width="1"/><text x="${padL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="var(--c-text-3)" font-size="10">${esc(formatAxisNumber(val))}</text>`;
		})
		.join("");

	const catCount = categories.length;
	const slotW = plotW / catCount;
	const xLabels = categories
		.map((cat, idx) => {
			const x =
				chart.type === "bar" || catCount === 1 ? padL + slotW * (idx + 0.5) : padL + (plotW * idx) / (catCount - 1);
			const short = cat.length > 10 ? `${cat.slice(0, 9)}…` : cat;
			return `<text x="${x.toFixed(1)}" y="${height - 14}" text-anchor="middle" fill="var(--c-text-3)" font-size="10">${esc(short)}</text>`;
		})
		.join("");

	const shapes: string[] = [];
	const legend: string[] = [];

	if (chart.type === "bar") {
		const barGroupW = slotW * 0.72;
		const barW = Math.max(4, barGroupW / series.length);
		const groupOffset = (slotW - barW * series.length) / 2;
		for (const [sIdx, s] of series.entries()) {
			const color = CHART_COLORS[sIdx % CHART_COLORS.length] ?? "#58A6FF";
			const map = new Map(s.data.map((p) => [p.label, p.value] as const));
			legend.push(
				`<li class="wc-chart-leg-item"><span class="wc-swatch" style="background:${color}"></span><span class="wc-leg-label">${esc(s.name)}</span></li>`,
			);
			for (const [cIdx, cat] of categories.entries()) {
				const val = map.get(cat);
				if (val === undefined || !Number.isFinite(val)) continue;
				const x = padL + cIdx * slotW + groupOffset + sIdx * barW;
				const yVal = yFor(val);
				const h = val === 0 ? 1 : Math.max(1.5, Math.abs(zeroY - yVal));
				const top = val >= 0 ? Math.min(yVal, zeroY - h) : zeroY;
				shapes.push(
					`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(2, barW - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"><title>${esc(s.name)} · ${esc(cat)}: ${esc(formatAxisNumber(val))}</title></rect>`,
				);
			}
		}
	} else {
		for (const [sIdx, s] of series.entries()) {
			const color = CHART_COLORS[sIdx % CHART_COLORS.length] ?? "#58A6FF";
			const map = new Map(s.data.map((p) => [p.label, p.value] as const));
			legend.push(
				`<li class="wc-chart-leg-item"><span class="wc-swatch" style="background:${color}"></span><span class="wc-leg-label">${esc(s.name)}</span></li>`,
			);
			const pts: Array<{ x: number; y: number; cat: string; val: number }> = [];
			for (const [cIdx, cat] of categories.entries()) {
				const val = map.get(cat);
				if (val === undefined || !Number.isFinite(val)) continue;
				const x = catCount === 1 ? padL + plotW / 2 : padL + (plotW * cIdx) / (catCount - 1);
				pts.push({ x, y: yFor(val), cat, val });
			}
			if (pts.length === 0) continue;
			const polyPts = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
			if (chart.type === "area" && pts.length >= 2) {
				const firstX = pts[0]?.x.toFixed(1) ?? String(padL);
				const lastX = pts.at(-1)?.x.toFixed(1) ?? String(padL + plotW);
				shapes.push(
					`<polygon points="${firstX},${zeroY.toFixed(1)} ${polyPts} ${lastX},${zeroY.toFixed(1)}" fill="${color}" fill-opacity="0.18"/>`,
				);
			}
			if (pts.length >= 2) {
				shapes.push(
					`<polyline points="${polyPts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
				);
			}
			for (const p of pts) {
				shapes.push(
					`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${color}" stroke="var(--c-surface)" stroke-width="1.2"><title>${esc(s.name)} · ${esc(p.cat)}: ${esc(formatAxisNumber(p.val))}</title></circle>`,
				);
			}
		}
	}

	const yTitle = chart.yLabel ? `<div class="wc-chart-axis">${esc(chart.yLabel)}</div>` : "";
	const xTitle = chart.xLabel ? `<div class="wc-chart-axis wc-chart-axis-x">${esc(chart.xLabel)}</div>` : "";
	return `<div class="wc-chart-wrap">${yTitle}<svg class="wc-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(element.title)}">${gridAndTicks}${xLabels}${shapes.join("")}</svg>${xTitle}${legend.length > 0 ? `<ul class="wc-chart-leg">${legend.join("")}</ul>` : ""}</div>`;
}

function renderCardChildHtml(child: CardChild): string {
	switch (child.type) {
		case "text":
			if (child.style === "bold")
				return `<p class="wc-card-text"><strong>${renderMarkdown(child.content)}</strong></p>`;
			if (child.style === "muted") return `<p class="wc-muted">${renderMarkdown(child.content)}</p>`;
			return `<div class="wc-card-text">${renderMarkdown(child.content)}</div>`;
		case "fields":
			return `<dl class="wc-fields">${child.children
				.map((field) => `<div class="wc-field"><dt>${esc(field.label)}</dt><dd>${esc(field.value)}</dd></div>`)
				.join("")}</dl>`;
		case "table": {
			const align = child.align ?? [];
			const head = child.headers
				.map((h, i) => `<th style="text-align:${esc(align[i] ?? "left")}">${esc(h)}</th>`)
				.join("");
			const rows = child.rows
				.map(
					(row) =>
						`<tr>${child.headers
							.map((_, i) => `<td style="text-align:${esc(align[i] ?? "left")}">${esc(row[i] ?? "")}</td>`)
							.join("")}</tr>`,
				)
				.join("");
			const caption = child.caption ? `<caption>${esc(child.caption)}</caption>` : "";
			return `<div class="wc-table"><table>${caption}<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
		}
		case "chart":
			return `<div class="wc-chart"><div class="wc-chart-title">${esc(child.title)}</div>${renderSeriesChartSvg(child)}</div>`;
		case "divider":
			return '<hr class="wc-divider">';
		case "link": {
			const href = safeHref(child.url);
			return href === undefined
				? `<span>${esc(child.label)}</span>`
				: `<a class="wc-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(child.label)}</a>`;
		}
		case "image": {
			const href = safeHref(child.url);
			return href === undefined
				? `<span>${esc(child.alt ?? "image")}</span>`
				: `<a class="wc-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">[이미지: ${esc(child.alt ?? "보기")}]</a>`;
		}
		case "section":
			return `<div class="wc-section">${child.children.map(renderCardChildHtml).join("")}</div>`;
		default:
			return "";
	}
}

/** Renders a validated json-render `CardElement` as pure HTML with tables and inline SVG charts. */
export function renderCardElementHtml(card: CardElement, tone?: CardTone): string {
	const toneCls = tone ? ` wc-tone-${tone}` : "";
	const title = card.title ? `<h4 class="wc-card-title">${esc(card.title)}</h4>` : "";
	const subtitle = card.subtitle ? `<p class="wc-card-sub">${esc(card.subtitle)}</p>` : "";
	const body = card.children.map(renderCardChildHtml).join("");
	return `<article class="wc-card${toneCls}">${title}${subtitle}<div class="wc-card-body">${body}</div></article>`;
}

function renderStructuredCardJson(text: string, cardJson: string): string | undefined {
	try {
		const parsed = JSON.parse(cardJson) as {
			kind?: unknown;
			title?: unknown;
			body?: unknown;
			fields?: Array<{ label: string; value: string }>;
			buttonsNote?: unknown;
		};
		if (parsed.kind === "status" || parsed.kind === "conversation") return undefined;
		const fieldsList = Array.isArray(parsed.fields) ? parsed.fields : [];
		const title =
			typeof parsed.title === "string" && parsed.title !== ""
				? `<h4 class="wc-card-title">${esc(parsed.title)}</h4>`
				: "";
		const headLine = title !== "" ? title : `<h4 class="wc-card-title">${esc(text.split("\n")[0] ?? "")}</h4>`;
		const bodyHtml =
			typeof parsed.body === "string" && parsed.body !== ""
				? `<div class="wc-card-text">${renderMarkdown(parsed.body)}</div>`
				: title !== "" && text !== ""
					? `<div class="wc-card-text">${renderMarkdown(text)}</div>`
					: "";
		const fieldsHtml =
			fieldsList.length > 0
				? `<dl class="wc-fields">${fieldsList.map((f) => `<div class="wc-field"><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join("")}</dl>`
				: "";
		const noteHtml =
			typeof parsed.buttonsNote === "string" && parsed.buttonsNote !== ""
				? `<p class="wc-card-note">${esc(parsed.buttonsNote)}</p>`
				: "";
		return `<article class="wc-card wc-card-prompt">${headLine}<div class="wc-card-body">${bodyHtml}${fieldsHtml}${noteHtml}</div></article>`;
	} catch {
		return undefined;
	}
}

/** Renders a `web_messages` row's body, expanding valid ```` ```card ```` specs (including charts/tables) and ```` ```copy ```` fences. */
export function renderWebMessageHtml(row: Pick<WebMessageRow, "role" | "text" | "cardJson" | "filesJson">): string {
	const parts: string[] = [];
	if (row.cardJson !== null) {
		const structured = renderStructuredCardJson(row.text, row.cardJson);
		if (structured !== undefined) parts.push(structured);
	}
	if (parts.length === 0) {
		for (const seg of splitCards(row.text)) {
			if (seg.kind === "text") {
				if (seg.text.trim() !== "") parts.push(`<div class="wc-md">${renderMarkdown(seg.text)}</div>`);
			} else if (seg.kind === "copy") {
				parts.push(
					`<div class="wc-copy"><pre class="md-code"><code>${esc(seg.text)}</code></pre><button type="button" class="wc-copy-btn" data-copy="${esc(seg.text)}">복사</button></div>`,
				);
			} else {
				const validated = validateCard(seg.json);
				if (validated.ok) parts.push(renderCardElementHtml(validated.card, validated.tone));
				else parts.push(`<pre class="md-code"><code>${esc(seg.raw)}</code></pre>`);
			}
		}
	}
	if (row.filesJson !== null) {
		try {
			const files = JSON.parse(row.filesJson) as Array<{ path?: string; title?: string; name?: string }>;
			if (Array.isArray(files) && files.length > 0) {
				const chips = files
					.map(
						(f) =>
							`<span class="wc-file-chip">📎 ${esc(f.title ?? f.name ?? (f.path ? basename(f.path) : "file"))}</span>`,
					)
					.join("");
				parts.push(`<div class="wc-files">${chips}</div>`);
			}
		} catch {
			// ignore malformed legacy files_json
		}
	}
	return parts.join("");
}
