// dsh-pdfium-preview — host half.
// The renderer runs inside the client renderer (PDFium compiled to WASM), so the
// host side has no routes, no tools and no state: it only has to exist so the
// loader entry has a main module.
export const name = 'dsh-pdfium-preview';
export const inject = [];

export function apply() {}
