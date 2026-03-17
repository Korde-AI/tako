/**
 * PDF text extraction utility using pdfjs-dist.
 */

import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfExtractResult {
  text: string;
  pageCount: number;
}

/**
 * Extract text content from a PDF buffer.
 *
 * @param params.buffer - Raw PDF data
 * @param params.maxPages - Maximum pages to extract (default: all)
 * @returns Extracted text and page count
 */
export async function extractPdfContent(params: {
  buffer: Buffer;
  maxPages?: number;
}): Promise<PdfExtractResult> {
  const { buffer, maxPages } = params;

  let pdf: PDFDocumentProxy | null = null;
  try {
    const data = new Uint8Array(buffer);
    pdf = await getDocument({ data, useSystemFonts: true }).promise;

    const totalPages = pdf.numPages;
    const pagesToExtract = maxPages ? Math.min(maxPages, totalPages) : totalPages;
    const pages: string[] = [];

    for (let i = 1; i <= pagesToExtract; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: unknown) => {
          const textItem = item as { str?: string };
          return textItem.str ?? '';
        })
        .join(' ');
      if (pageText.trim()) {
        pages.push(`--- Page ${i} ---\n${pageText.trim()}`);
      }
    }

    return {
      text: pages.join('\n\n'),
      pageCount: totalPages,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/password/i.test(msg)) {
      return { text: '[PDF is password-protected and cannot be read]', pageCount: 0 };
    }
    return { text: `[Failed to extract PDF text: ${msg}]`, pageCount: 0 };
  } finally {
    if (pdf) {
      await pdf.destroy();
    }
  }
}
