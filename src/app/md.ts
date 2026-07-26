// Tiny markdown renderer for mango details popups. HTML-escapes everything
// first, then supports exactly what the catalog uses: #–#### headings,
// - bullets, **bold**, *italic*, and blank-line paragraphs. No dependency,
// no HTML pass-through — safe for admin-entered content.

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const inline = (s: string): string =>
  escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

export function renderMarkdown(md: string): string {
  let html = '';
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = (): void => {
    if (para.length) {
      html += `<p>${para.map(inline).join(' ')}</p>`;
      para = [];
    }
  };
  const flushList = (): void => {
    if (list.length) {
      html += `<ul>${list.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`;
      list = [];
    }
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      // # → h3 … #### → h6: the popup already has an h2 for the mango name.
      const level = Math.min(heading[1].length + 2, 6);
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      continue;
    }
    const bullet = line.match(/^[-*•·]\s+(.*)$/);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return html;
}
