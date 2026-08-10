/**
 * PDF.js worker setup for document preview
 */

import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export { pdfjsLib };

/** CSS pixels per PDF point at 100% zoom (96 DPI screen) */
export const PDF_BASE_SCALE = 96 / 72;

export async function loadPdfDocument(blob) {
  const buffer = await blob.arrayBuffer();
  return pdfjsLib.getDocument({ data: buffer }).promise;
}
