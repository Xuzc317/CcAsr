//#region src/services/api.ts
var STRUCT_RE = /<!--\s*CCASR_STRUCTURED_SUMMARY\s*([\s\S]*?)\s*-->/;
/**
* 从纪要 Markdown 中提取内嵌的结构化 JSON。
*
* 后端把结构化 blocks 以 HTML 注释形式内嵌，前端优先用它渲染组件；
* 解析失败返回 null，调用方回退为 Markdown 渲染（优雅降级）。
*/
function parseStructuredSummary(markdown) {
	const m = STRUCT_RE.exec(markdown || "");
	if (!m) return null;
	try {
		const data = JSON.parse(m[1]);
		if (data && Array.isArray(data.blocks)) return data;
	} catch {}
	return null;
}
/** 取出纪要正文（去掉内嵌的结构化注释与降级提示） */
function summaryBodyMarkdown(markdown) {
	return (markdown || "").replace(STRUCT_RE, "").trim();
}
//#endregion
//#region src/utils/format.ts
/**
* 轻量 Markdown 处理工具。
*
* 会议纪要里的要点句式是「**加粗标签**：内容」，只需要支持加粗与转义，
* 因此不引入完整 Markdown 库，避免 XSS 与打包体积。
*/
/** 转义 HTML 特殊字符 */
function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** 把 **加粗** 转成 <strong>，其余内容转义；返回可直接 dangerouslySetInnerHTML 的串 */
function renderInline(s) {
	return escapeHtml(s || "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
/** 秒 → HH:MM:SS */
function formatTime(seconds) {
	const s = Math.max(0, Math.floor(seconds || 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor(s % 3600 / 60);
	const sec = s % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
/** 依据说话人 ID 稳定地取一个主题色（参考元宝的独立主题色卡片）*/
var PALETTE = [
	"#4361ee",
	"#2a9d8f",
	"#e76f51",
	"#7209b7",
	"#f4a261",
	"#118ab2",
	"#ef476f",
	"#06d6a0"
];
function speakerColor(speaker) {
	let hash = 0;
	for (let i = 0; i < speaker.length; i++) hash = hash * 31 + speaker.charCodeAt(i) >>> 0;
	return PALETTE[hash % PALETTE.length];
}
//#endregion
export { escapeHtml, formatTime, parseStructuredSummary, renderInline, speakerColor, summaryBodyMarkdown };
