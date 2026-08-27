/**
 * Render one HTML file to PDF, with a running header and page numbers.
 *
 * Documentation tooling, not part of either product.
 *
 * Electron is the renderer rather than a LaTeX or a Python toolchain because it is already
 * a pinned dependency of `app/`: a machine that can build the desktop application can build
 * the manual, with no system libraries to install and no version of Pango or TeX to keep in
 * step. Chromium also does the one thing the alternatives here could not — running header
 * and footer templates with real page numbers.
 *
 *   AMRIT_MANUAL_HTML=/path/in.html AMRIT_MANUAL_PDF=/path/out.pdf \
 *   AMRIT_MANUAL_HEADER='<div>…</div>' AMRIT_MANUAL_FOOTER='<div>…</div>' \
 *   app/node_modules/.bin/electron tools/manual/render_pdf.mjs
 */

import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow } from 'electron'

const source = process.env.AMRIT_MANUAL_HTML
const target = process.env.AMRIT_MANUAL_PDF
const header = process.env.AMRIT_MANUAL_HEADER ?? ''
const footer = process.env.AMRIT_MANUAL_FOOTER ?? ''

if (!source || !target) {
  console.error('AMRIT_MANUAL_HTML and AMRIT_MANUAL_PDF are required')
  process.exit(2)
}

// Chromium counts the cover as page 1 and there is no way to suppress its header there
// through the template alone, so the cover hides it with its own full-bleed white block.
const settle = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1240, height: 1754 })
  await window.loadURL(pathToFileURL(source).href)
  // Images are local files and load synchronously enough, but web fonts and the layout
  // settle a beat later; printing sooner produces a PDF with the first page half-styled.
  await settle(1500)
  const pdf = await window.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    displayHeaderFooter: Boolean(header || footer),
    headerTemplate: header || '<span></span>',
    footerTemplate: footer || '<span></span>',
    margins: { top: 0.85, bottom: 0.75, left: 0.7, right: 0.7 },
    preferCSSPageSize: false,
    generateTaggedPDF: true,
    generateDocumentOutline: true
  })
  await writeFile(target, pdf)
  console.log(`wrote ${target} (${(pdf.length / 1_000_000).toFixed(2)} MB)`)
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
