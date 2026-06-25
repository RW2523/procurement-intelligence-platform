import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";

function inlineRuns(text: string): TextRun[] {
  // Split on **bold** while keeping the delimiters' content.
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) =>
    p.startsWith("**") && p.endsWith("**")
      ? new TextRun({ text: p.slice(2, -2), bold: true })
      : new TextRun(p),
  );
}

/** Convert a Markdown-ish draft into a Word document buffer for submission. */
export async function markdownToDocxBuffer(title: string, content: string): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (!t) {
      children.push(new Paragraph({ text: "" }));
    } else if (t.startsWith("### ")) {
      children.push(new Paragraph({ text: t.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (t.startsWith("## ")) {
      children.push(new Paragraph({ text: t.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (t.startsWith("# ")) {
      children.push(new Paragraph({ text: t.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (/^[-*]\s+/.test(t)) {
      children.push(new Paragraph({ children: inlineRuns(t.replace(/^[-*]\s+/, "")), bullet: { level: 0 } }));
    } else if (t.startsWith(">")) {
      children.push(new Paragraph({ children: inlineRuns(t.replace(/^>\s?/, "")), style: "IntenseQuote" }));
    } else if (/^\|.*\|$/.test(t)) {
      // Render table rows as plain text lines (keeps content without complex tables).
      children.push(new Paragraph({ children: inlineRuns(t.replace(/\|/g, "  ").trim()) }));
    } else {
      children.push(new Paragraph({ children: inlineRuns(t) }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
