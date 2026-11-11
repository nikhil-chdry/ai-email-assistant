import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function extractPdfText(buffer) {
  const document = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pages.push(textContent.items.map((item) => item.str).join(" ").trim());
    }
    return pages.filter(Boolean).join("\n\n").trim();
  } finally {
    await document.destroy();
  }
}

