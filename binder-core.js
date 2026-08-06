/* IMPI JOC Binder Assembler — core generation logic
 * Works in both the browser (via <script> + window.PDFLib from CDN)
 * and Node (via require('pdf-lib')) so it can be unit-tested here
 * before it ever reaches Shane's machine.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('pdf-lib'));
  } else {
    root.BinderCore = factory(root.PDFLib);
  }
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  const { PDFDocument, StandardFonts, rgb, PageSizes, PDFName } = PDFLib;

  // ---- IMPI brand constants ----
  const RED = rgb(222 / 255, 24 / 255, 25 / 255);
  const GOLD = rgb(253 / 255, 219 / 255, 7 / 255);
  const DARK = rgb(35 / 255, 31 / 255, 32 / 255);
  const GREY = rgb(0.45, 0.45, 0.45);
  const LIGHT_GREY = rgb(0.94, 0.94, 0.94);
  const BAR_GREY = rgb(0.91, 0.91, 0.92);
  const WHITE = rgb(1, 1, 1);

  const PAGE_W = PageSizes.A4[0]; // 595.28
  const PAGE_H = PageSizes.A4[1]; // 841.89
  const MARGIN = 50;

  function detectImageType(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
    return null;
  }

  async function embedImageAuto(doc, bytes) {
    const type = detectImageType(bytes);
    if (type === 'png') return doc.embedPng(bytes);
    if (type === 'jpg') return doc.embedJpg(bytes);
    throw new Error('Logo must be a PNG or JPG file.');
  }

  function scaleToWidth(img, targetWidth) {
    const ratio = targetWidth / img.width;
    return { width: targetWidth, height: img.height * ratio };
  }
  function scaleToHeight(img, targetHeight) {
    const ratio = targetHeight / img.height;
    return { width: img.width * ratio, height: targetHeight };
  }
  function scaleToFit(img, maxWidth, maxHeight) {
    const byWidth = scaleToWidth(img, maxWidth);
    if (byWidth.height <= maxHeight) return byWidth;
    return scaleToHeight(img, maxHeight);
  }

  function drawDashedRect(page, x, y, w, h, color) {
    const dash = 6, gap = 4;
    // top & bottom
    for (let dx = 0; dx < w; dx += dash + gap) {
      const len = Math.min(dash, w - dx);
      page.drawLine({ start: { x: x + dx, y: y + h }, end: { x: x + dx + len, y: y + h }, thickness: 1, color });
      page.drawLine({ start: { x: x + dx, y: y }, end: { x: x + dx + len, y: y }, thickness: 1, color });
    }
    // left & right
    for (let dy = 0; dy < h; dy += dash + gap) {
      const len = Math.min(dash, h - dy);
      page.drawLine({ start: { x: x, y: y + dy }, end: { x: x, y: y + dy + len }, thickness: 1, color });
      page.drawLine({ start: { x: x + w, y: y + dy }, end: { x: x + w, y: y + dy + len }, thickness: 1, color });
    }
  }

  function addLinkAnnotation(page, rect, targetPageRef) {
    const context = page.doc.context;
    const annotDict = context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
      Border: [0, 0, 0],
      Dest: [targetPageRef, PDFName.of('XYZ'), null, null, null],
    });
    const annotRef = context.register(annotDict);
    const existing = page.node.get(PDFName.of('Annots'));
    if (existing) {
      existing.push(annotRef);
    } else {
      page.node.set(PDFName.of('Annots'), context.obj([annotRef]));
    }
  }

  function wrapText(text, font, size, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Groups documents into sections by the LEADING NUMBER of their section number.
  // e.g. "2a", "2b", "2c" all share group key "2" and become ONE section with
  // ONE divider page listing all three underneath it. A bare "6" or "10c" with
  // no sibling sharing that same leading number stays its own single-document
  // section, exactly as before. Grouping only merges CONSECUTIVE documents in
  // the list, so ordering the sub-documents together (via the up/down arrows)
  // is what controls which items get grouped.
  function parseSectionKey(sectionNumber) {
    const raw = String(sectionNumber || '').trim();
    const m = raw.match(/^(\d+)/);
    return m ? m[1] : raw;
  }

  function groupDocuments(documents) {
    const groups = [];
    for (const docSpec of documents) {
      const key = parseSectionKey(docSpec.sectionNumber);
      const last = groups[groups.length - 1];
      if (last && last.key === key) {
        last.items.push(docSpec);
      } else {
        groups.push({ key, items: [docSpec] });
      }
    }
    return groups;
  }

  function fitTitleSize(text, font, maxWidth, startSize, minSize) {
    let size = startSize;
    while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) size -= 1;
    return size;
  }

  async function generateBinder(opts) {
    const {
      submissionType = 'joc', // 'joc' | 'outstanding'
      eventName = 'Untitled Event',
      clientName = '',
      venue = '',
      eventDate = '',
      preparedBy = 'IMPI RMS (Pty) Ltd',
      docVersion = 'V1.0',
      impiLogoBytes,
      clientLogoBytes = null,
      documents = [], // [{ bytes, sectionNumber, title }]
      onProgress = () => {},
      // Outstanding-submission-only fields (all optional, all ignored in 'joc' mode)
      jocReference = '',
      addressedTo = '',
      requestedDate = '',
      submissionDate = '',
      signatoryName = 'Shane Steynfaardt',
      signatoryTitle = 'Senior Operations Manager',
      outstandingItems = [], // [{ itemText, sectionRef }]
    } = opts;

    const isOutstanding = submissionType === 'outstanding';
    const todayStr = new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
    const effectiveSubmissionDate = submissionDate || todayStr;

    if (!impiLogoBytes) throw new Error('IMPI logo bytes are required.');
    if (!documents.length) throw new Error('At least one document is required.');

    const outDoc = await PDFDocument.create();
    const helv = await outDoc.embedFont(StandardFonts.Helvetica);
    const helvB = await outDoc.embedFont(StandardFonts.HelveticaBold);

    const impiLogo = await embedImageAuto(outDoc, impiLogoBytes);
    const clientLogo = clientLogoBytes ? await embedImageAuto(outDoc, clientLogoBytes) : null;

    // Group documents into sections up front (e.g. 2a/2b/2c collapse into one
    // "Section 2") so the cover page's section count reflects reality, not just
    // the number of files uploaded.
    const groups = groupDocuments(documents);

    // ---------------- Cover page ----------------
    const cover = outDoc.addPage([PAGE_W, PAGE_H]);
    const logoDim = scaleToFit(impiLogo, 150, 70);
    cover.drawImage(impiLogo, {
      x: MARGIN,
      y: PAGE_H - MARGIN - logoDim.height,
      width: logoDim.width,
      height: logoDim.height,
    });

    const logoBoxW = 150, logoBoxH = 70;
    const logoBoxX = PAGE_W - MARGIN - logoBoxW;
    const logoBoxY = PAGE_H - MARGIN - logoBoxH;
    if (clientLogo) {
      const cDim = scaleToFit(clientLogo, logoBoxW, logoBoxH);
      cover.drawImage(clientLogo, {
        x: logoBoxX + (logoBoxW - cDim.width) / 2,
        y: logoBoxY + (logoBoxH - cDim.height) / 2,
        width: cDim.width,
        height: cDim.height,
      });
    } else {
      drawDashedRect(cover, logoBoxX, logoBoxY, logoBoxW, logoBoxH, GREY);
      const label = 'CLIENT / EVENT LOGO';
      const w = helv.widthOfTextAtSize(label, 8);
      cover.drawText(label, {
        x: logoBoxX + (logoBoxW - w) / 2,
        y: logoBoxY + logoBoxH / 2 - 4,
        size: 8,
        font: helv,
        color: GREY,
      });
    }

    let cy = PAGE_H - MARGIN - logoBoxH - 30;
    cover.drawRectangle({ x: 0, y: cy, width: PAGE_W, height: 8, color: RED });
    cy -= 55;
    const title = isOutstanding ? 'OUTSTANDING DOCUMENTATION SUBMISSION' : 'JOC PRESENTATION FILE';
    const titleSize = fitTitleSize(title, helvB, PAGE_W - 2 * MARGIN - 20, 26, 15);
    const titleW = helvB.widthOfTextAtSize(title, titleSize);
    cover.drawText(title, { x: (PAGE_W - titleW) / 2, y: cy, size: titleSize, font: helvB, color: DARK });

    cy -= 34;
    const evSize = 18;
    const evW = helvB.widthOfTextAtSize(eventName, evSize);
    cover.drawText(eventName, { x: (PAGE_W - evW) / 2, y: cy, size: evSize, font: helvB, color: RED });

    cy -= 45;
    cover.drawLine({ start: { x: MARGIN, y: cy }, end: { x: PAGE_W - MARGIN, y: cy }, thickness: 2, color: GOLD });
    cy -= 28;

    const infoRows = isOutstanding
      ? [
          ['CLIENT', clientName],
          ['VENUE', venue],
          ['EVENT DATE', eventDate],
          ['JOC REFERENCE', jocReference || 'N/A'],
          ['ITEMS REQUESTED ON', requestedDate || 'N/A'],
          ['SUBMISSION DATE', effectiveSubmissionDate],
        ]
      : [
          ['CLIENT', clientName],
          ['VENUE', venue],
          ['EVENT DATE', eventDate],
        ];
    for (const [label, value] of infoRows) {
      cover.drawText(label, { x: MARGIN, y: cy, size: 10, font: helvB, color: DARK });
      cover.drawText(value || 'N/A', { x: MARGIN + 140, y: cy, size: 11, font: helv, color: DARK });
      cy -= 22;
    }

    // Document control block near bottom
    const dcY = isOutstanding ? 130 : 170;
    cover.drawLine({ start: { x: MARGIN, y: dcY + 20 }, end: { x: PAGE_W - MARGIN, y: dcY + 20 }, thickness: 1, color: GOLD });
    cover.drawText('DOCUMENT CONTROL', { x: MARGIN, y: dcY, size: 11, font: helvB, color: DARK });
    const dcRows = [
      ['Prepared by', preparedBy],
      ['Version', docVersion],
      ['Date generated', todayStr],
      [isOutstanding ? 'Documents submitted' : 'Total sections', isOutstanding ? String(documents.length) : String(groups.length)],
    ];
    let dcy2 = dcY - 20;
    for (const [label, value] of dcRows) {
      cover.drawText(label + ':', { x: MARGIN, y: dcy2, size: 9, font: helvB, color: GREY });
      cover.drawText(value, { x: MARGIN + 110, y: dcy2, size: 9, font: helv, color: DARK });
      dcy2 -= 15;
    }

    // ---------------- Outstanding-submission-only: transmittal letter ----------------
    let letterPage = null;
    if (isOutstanding) {
      letterPage = outDoc.addPage([PAGE_W, PAGE_H]);
      const lp = letterPage;
      const smallLogoDim = scaleToFit(impiLogo, 90, 40);
      lp.drawImage(impiLogo, { x: MARGIN, y: PAGE_H - MARGIN - smallLogoDim.height, width: smallLogoDim.width, height: smallLogoDim.height });
      const dateW = helv.widthOfTextAtSize(effectiveSubmissionDate, 10);
      lp.drawText(effectiveSubmissionDate, { x: PAGE_W - MARGIN - dateW, y: PAGE_H - MARGIN - 15, size: 10, font: helv, color: DARK });

      let ly = PAGE_H - MARGIN - smallLogoDim.height - 40;
      const bodyWidth = PAGE_W - 2 * MARGIN;

      if (addressedTo.trim()) {
        const addrLines = addressedTo.split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of addrLines) {
          lp.drawText(line, { x: MARGIN, y: ly, size: 10, font: helv, color: DARK });
          ly -= 14;
        }
        ly -= 20;
      }

      lp.drawText('Dear Sir / Madam,', { x: MARGIN, y: ly, size: 10.5, font: helv, color: DARK });
      ly -= 28;

      const refSuffix = jocReference ? ` (JOC REF: ${jocReference.toUpperCase()})` : '';
      const reLine = `RE: SUBMISSION OF OUTSTANDING DOCUMENTATION – ${eventName.toUpperCase()}${refSuffix}`;
      for (const line of wrapText(reLine, helvB, 11, bodyWidth)) {
        lp.drawText(line, { x: MARGIN, y: ly, size: 11, font: helvB, color: DARK });
        ly -= 16;
      }
      ly -= 14;

      const para1 = requestedDate
        ? `Further to your correspondence dated ${requestedDate}, we hereby submit the outstanding documentation requested in respect of the above-mentioned event.`
        : `Further to your correspondence regarding the above-mentioned event, we hereby submit the outstanding documentation requested.`;
      const para2 = `The enclosed documents, listed in the accompanying Schedule of Outstanding Items, are submitted in satisfaction of the outstanding requirements raised. Should any further information or clarification be required, please do not hesitate to contact the undersigned.`;
      const para3 = `We trust that this submission finds the outstanding matters in order, and respectfully request that the event be considered fully compliant for approval.`;

      for (const para of [para1, para2, para3]) {
        for (const line of wrapText(para, helv, 10.5, bodyWidth)) {
          lp.drawText(line, { x: MARGIN, y: ly, size: 10.5, font: helv, color: DARK });
          ly -= 15;
        }
        ly -= 13;
      }

      ly -= 6;
      lp.drawText('Yours faithfully,', { x: MARGIN, y: ly, size: 10.5, font: helv, color: DARK });
      ly -= 50;
      lp.drawLine({ start: { x: MARGIN, y: ly + 12 }, end: { x: MARGIN + 180, y: ly + 12 }, thickness: 0.75, color: GREY });
      lp.drawText(signatoryName, { x: MARGIN, y: ly, size: 10.5, font: helvB, color: DARK });
      ly -= 14;
      lp.drawText(signatoryTitle, { x: MARGIN, y: ly, size: 9.5, font: helv, color: GREY });
      ly -= 14;
      lp.drawText('IMPI RMS (Pty) Ltd', { x: MARGIN, y: ly, size: 9.5, font: helv, color: GREY });
    }

    // ---------------- Outstanding-submission-only: Schedule of Outstanding Items ----------------
    // Precompute the row layout (wrapped line counts, row heights, page breaks) BEFORE
    // creating pages, since none of that depends on final page numbers — only the
    // "Page" column (filled in later) needs pageNumberOf.
    const schedHeaderH = 90, schedTopPad = 22, schedLineH = 13, schedRowPad = 10;
    const colNumW = 22, colGap = 10;
    const colItemW = 215, colDocW = 140, colRefW = 40, colPageW = 46;
    const colNumX = MARGIN;
    const colItemX = colNumX + colNumW + colGap;
    const colDocX = colItemX + colItemW + colGap;
    const colRefX = colDocX + colDocW + colGap;
    const colPageX = colRefX + colRefW + colGap;

    function findMatchedDoc(sectionRef) {
      if (!sectionRef || !sectionRef.trim()) return null;
      const needle = sectionRef.trim().toLowerCase();
      return documents.find((d) => String(d.sectionNumber || '').trim().toLowerCase() === needle) || null;
    }

    const schedRowsLayout = [];
    if (isOutstanding && outstandingItems.length) {
      outstandingItems.forEach((oi, idx) => {
        const matched = findMatchedDoc(oi.sectionRef);
        const itemLines = wrapText(oi.itemText || '(untitled item)', helv, 10, colItemW);
        const docLabel = matched ? matched.title : (oi.sectionRef && oi.sectionRef.trim() ? `Not found: "${oi.sectionRef}"` : '—');
        const docLines = wrapText(docLabel, helv, 10, colDocW);
        const lineCount = Math.max(itemLines.length, docLines.length, 1);
        const rowHeight = lineCount * schedLineH + schedRowPad;
        schedRowsLayout.push({ idx: idx + 1, itemLines, docLines, ref: oi.sectionRef || '—', matched, rowHeight });
      });
    }

    // Paginate the precomputed rows
    const schedPagesRowGroups = [];
    if (schedRowsLayout.length) {
      let current = [];
      let usedH = 0;
      const usableH = PAGE_H - schedHeaderH - schedTopPad - 70; // leave room for footer
      for (const row of schedRowsLayout) {
        if (current.length && usedH + row.rowHeight > usableH) {
          schedPagesRowGroups.push(current);
          current = [];
          usedH = 0;
        }
        current.push(row);
        usedH += row.rowHeight;
      }
      if (current.length) schedPagesRowGroups.push(current);
    }

    const schedulePages = schedPagesRowGroups.map(() => outDoc.addPage([PAGE_W, PAGE_H]));

    // ---------------- Group documents into sections ----------------
    // (already computed above, before the cover page, so the section count is accurate there)
    // Row count used to size the TOC: grouped sections get 1 header row +
    // 1 row per sub-document; single-document sections get 1 row, same as before.
    const tocRowCount = groups.reduce((sum, g) => sum + (g.items.length > 1 ? 1 + g.items.length : 1), 0);

    // ---------------- TOC pages ----------------
    const rowsPerPage = 30;
    const tocPageCount = Math.max(1, Math.ceil(tocRowCount / rowsPerPage));
    const tocPages = [];
    for (let i = 0; i < tocPageCount; i++) {
      tocPages.push(outDoc.addPage([PAGE_W, PAGE_H]));
    }

    // ---------------- Sections: ONE divider per group + all its documents ----------------
    const sectionPlan = [];
    let docCounter = 0;
    for (const group of groups) {
      const divider = outDoc.addPage([PAGE_W, PAGE_H]);
      const items = [];
      for (const docSpec of group.items) {
        onProgress({ stage: 'embedding', index: docCounter, total: documents.length, title: docSpec.title });
        docCounter++;
        const srcDoc = await PDFDocument.load(docSpec.bytes, { ignoreEncryption: true });
        const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
        copiedPages.forEach((p) => outDoc.addPage(p));
        items.push({
          sectionNumber: docSpec.sectionNumber || group.key,
          title: docSpec.title || 'Untitled document',
          firstContentPage: copiedPages[0] || divider,
          pageCount: copiedPages.length,
        });
      }
      sectionPlan.push({
        groupKey: group.key,
        dividerPage: divider,
        items,
      });
    }

    // Map each raw docSpec (from the `documents` array, by reference) to the page
    // its content starts on — used by the Schedule of Outstanding Items to resolve
    // "Document Provided" / "Page" columns without any fragile re-matching by text.
    const docRefToPage = new Map();
    groups.forEach((group, gi) => {
      group.items.forEach((docSpec, di) => {
        docRefToPage.set(docSpec, sectionPlan[gi].items[di].firstContentPage);
      });
    });

    // Build a page -> number map now that every page exists
    const allPages = outDoc.getPages();
    const pageNumberOf = new Map();
    allPages.forEach((p, idx) => pageNumberOf.set(p, idx + 1));
    const totalPages = allPages.length;

    // ---------------- Draw Schedule of Outstanding Items content ----------------
    // (deferred until now because the "Page" column needs pageNumberOf, which only
    // exists once every content page has been embedded)
    schedPagesRowGroups.forEach((rowsOnPage, pageIdx) => {
      const sp = schedulePages[pageIdx];
      sp.drawRectangle({ x: 0, y: PAGE_H - schedHeaderH, width: PAGE_W, height: schedHeaderH, color: BAR_GREY });
      sp.drawRectangle({ x: 0, y: PAGE_H - schedHeaderH - 4, width: PAGE_W, height: 4, color: RED });
      const schedLogoDim = scaleToFit(impiLogo, 90, 40);
      sp.drawImage(impiLogo, { x: MARGIN, y: PAGE_H - schedHeaderH + (schedHeaderH - schedLogoDim.height) / 2 - 5, width: schedLogoDim.width, height: schedLogoDim.height });
      const schedHeading = 'SCHEDULE OF OUTSTANDING ITEMS';
      sp.drawText(schedHeading, { x: PAGE_W - MARGIN - helvB.widthOfTextAtSize(schedHeading, 14), y: PAGE_H - schedHeaderH / 2 - 6, size: 14, font: helvB, color: DARK });

      let ly = PAGE_H - schedHeaderH - schedTopPad;
      // column headers
      sp.drawText('#', { x: colNumX, y: ly, size: 9, font: helvB, color: GREY });
      sp.drawText('ITEM REQUESTED', { x: colItemX, y: ly, size: 9, font: helvB, color: GREY });
      sp.drawText('DOCUMENT PROVIDED', { x: colDocX, y: ly, size: 9, font: helvB, color: GREY });
      sp.drawText('REF', { x: colRefX, y: ly, size: 9, font: helvB, color: GREY });
      sp.drawText('PAGE', { x: colPageX, y: ly, size: 9, font: helvB, color: GREY });
      ly -= 16;
      sp.drawLine({ start: { x: MARGIN, y: ly + 4 }, end: { x: PAGE_W - MARGIN, y: ly + 4 }, thickness: 1, color: GOLD });
      ly -= 4;

      rowsOnPage.forEach((row, i) => {
        const rowTop = ly;
        if (i % 2 === 0) {
          sp.drawRectangle({ x: MARGIN, y: rowTop - row.rowHeight, width: PAGE_W - 2 * MARGIN, height: row.rowHeight, color: LIGHT_GREY });
        }
        let textY = rowTop - schedLineH + 2;
        sp.drawText(String(row.idx), { x: colNumX, y: textY, size: 10, font: helvB, color: RED });
        row.itemLines.forEach((line, li) => sp.drawText(line, { x: colItemX, y: textY - li * schedLineH, size: 10, font: helv, color: DARK }));
        row.docLines.forEach((line, li) => sp.drawText(line, { x: colDocX, y: textY - li * schedLineH, size: 10, font: helv, color: DARK }));
        sp.drawText(row.ref, { x: colRefX, y: textY, size: 10, font: helv, color: GREY });
        const pageNumStr = row.matched ? String(pageNumberOf.get(docRefToPage.get(row.matched)) || '—') : '—';
        sp.drawText(pageNumStr, { x: colPageX, y: textY, size: 10, font: helv, color: GREY });
        ly -= row.rowHeight;
      });
    });

    // ---------------- Draw TOC content ----------------
    const tocHeaderH = 90;
    const tocTopPad = 22; // breathing room between the header bar and the first row
    const rowH = 20;
    for (const tp of tocPages) {
      tp.drawRectangle({ x: 0, y: PAGE_H - tocHeaderH, width: PAGE_W, height: tocHeaderH, color: BAR_GREY });
      tp.drawRectangle({ x: 0, y: PAGE_H - tocHeaderH - 4, width: PAGE_W, height: 4, color: RED });
      const tocLogoDim = scaleToFit(impiLogo, 90, 40);
      tp.drawImage(impiLogo, { x: MARGIN, y: PAGE_H - tocHeaderH + (tocHeaderH - tocLogoDim.height) / 2 - 5, width: tocLogoDim.width, height: tocLogoDim.height });
      const tHeading = 'TABLE OF CONTENTS';
      tp.drawText(tHeading, { x: PAGE_W - MARGIN - helvB.widthOfTextAtSize(tHeading, 16), y: PAGE_H - tocHeaderH / 2 - 6, size: 16, font: helvB, color: DARK });
    }

    // Flatten sectionPlan into TOC rows: a bold "SECTION X" header row for any
    // group with more than one document, followed by an indented row per
    // sub-document (each linking straight to that document's own content,
    // not just the shared divider). Single-document sections render exactly
    // as one plain row, same as the original layout.
    const tocRows = [];
    for (const sec of sectionPlan) {
      if (sec.items.length > 1) {
        tocRows.push({ bold: true, indent: false, numberLabel: `SECTION ${sec.groupKey}`, title: '', targetPage: sec.dividerPage, targetRef: sec.dividerPage.ref });
        for (const item of sec.items) {
          tocRows.push({ bold: false, indent: true, numberLabel: item.sectionNumber, title: item.title, targetPage: item.firstContentPage, targetRef: item.firstContentPage.ref });
        }
      } else {
        const item = sec.items[0];
        tocRows.push({ bold: false, indent: false, numberLabel: item.sectionNumber, title: item.title, targetPage: sec.dividerPage, targetRef: sec.dividerPage.ref });
      }
    }

    let rowIndex = 0;
    for (const row of tocRows) {
      const pageIdx = Math.floor(rowIndex / rowsPerPage);
      const rowInPage = rowIndex % rowsPerPage;
      const tp = tocPages[pageIdx];
      const rowTop = PAGE_H - tocHeaderH - tocTopPad - rowInPage * rowH;
      const rowY = rowTop - rowH;

      if (rowInPage % 2 === 0) {
        tp.drawRectangle({ x: MARGIN, y: rowY, width: PAGE_W - 2 * MARGIN, height: rowH, color: LIGHT_GREY });
      }

      const pageNum = pageNumberOf.get(row.targetPage);
      const textY = rowY + 6;
      const indentX = row.indent ? 18 : 0;
      const numFont = row.bold ? helvB : helvB;
      const numSize = row.bold ? 11 : 10;

      tp.drawText(row.numberLabel, { x: MARGIN + 6 + indentX, y: textY, size: numSize, font: numFont, color: RED });

      if (row.title) {
        const titleMaxW = PAGE_W - 2 * MARGIN - 100 - 60 - indentX;
        const titleLines = wrapText(row.title, row.bold ? helvB : helv, 10.5, titleMaxW);
        tp.drawText(titleLines[0] || '', { x: MARGIN + 60 + indentX, y: textY, size: 10.5, font: row.bold ? helvB : helv, color: DARK });
      }

      const pageNumStr = String(pageNum);
      const pnW = helvB.widthOfTextAtSize(pageNumStr, 10);
      tp.drawText(pageNumStr, { x: PAGE_W - MARGIN - 6 - pnW, y: textY, size: 10, font: helvB, color: DARK });

      addLinkAnnotation(tp, { x: MARGIN, y: rowY, w: PAGE_W - 2 * MARGIN, h: rowH }, row.targetRef);

      rowIndex++;
    }

    // ---------------- Draw divider page content ----------------
    for (const sec of sectionPlan) {
      const dp = sec.dividerPage;
      const barH = 110;
      dp.drawRectangle({ x: 0, y: PAGE_H - barH, width: PAGE_W, height: barH, color: BAR_GREY });
      dp.drawRectangle({ x: 0, y: PAGE_H - barH - 5, width: PAGE_W, height: 5, color: RED });
      const dLogoDim = scaleToFit(impiLogo, 100, 45);
      dp.drawImage(impiLogo, { x: PAGE_W - MARGIN - dLogoDim.width, y: PAGE_H - barH + (barH - dLogoDim.height) / 2, width: dLogoDim.width, height: dLogoDim.height });

      if (sec.items.length > 1) {
        // ---- Grouped section: header + itemised breakdown of every sub-document ----
        const secLabel = `SECTION ${sec.groupKey}`;
        dp.drawText(secLabel, { x: MARGIN, y: PAGE_H - 50, size: 14, font: helvB, color: RED });

        const subtitle = `This section contains ${sec.items.length} documents`;
        dp.drawText(subtitle, { x: MARGIN, y: PAGE_H - 80, size: 20, font: helvB, color: DARK });

        dp.drawLine({ start: { x: MARGIN, y: PAGE_H - barH - 20 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - barH - 20 }, thickness: 2, color: GOLD });

        let ly = PAGE_H - barH - 55;
        dp.drawText('CONTENTS OF THIS SECTION', { x: MARGIN, y: ly, size: 10, font: helvB, color: GREY });
        ly -= 26;
        const listRowH = 26;
        sec.items.forEach((item, i) => {
          if (i % 2 === 0) {
            dp.drawRectangle({ x: MARGIN, y: ly - 7, width: PAGE_W - 2 * MARGIN, height: listRowH - 2, color: LIGHT_GREY });
          }
          const pageNum = pageNumberOf.get(item.firstContentPage);
          dp.drawText(item.sectionNumber, { x: MARGIN + 6, y: ly, size: 11, font: helvB, color: RED });
          const titleLines = wrapText(item.title, helv, 11, PAGE_W - 2 * MARGIN - 160);
          dp.drawText(titleLines[0] || '', { x: MARGIN + 60, y: ly, size: 11, font: helv, color: DARK });
          const pnStr = `Page ${pageNum}`;
          const pnW = helv.widthOfTextAtSize(pnStr, 10);
          dp.drawText(pnStr, { x: PAGE_W - MARGIN - 6 - pnW, y: ly, size: 10, font: helv, color: GREY });
          addLinkAnnotation(dp, { x: MARGIN, y: ly - 7, w: PAGE_W - 2 * MARGIN, h: listRowH }, item.firstContentPage.ref);
          ly -= listRowH;
        });
      } else {
        // ---- Single-document section: original full-title divider look ----
        const item = sec.items[0];
        const secLabel = `SECTION ${item.sectionNumber}`;
        dp.drawText(secLabel, { x: MARGIN, y: PAGE_H - 50, size: 14, font: helvB, color: RED });

        const titleLines = wrapText(item.title, helvB, 22, PAGE_W - 2 * MARGIN - 130);
        let ty = PAGE_H - 80;
        for (const line of titleLines.slice(0, 2)) {
          dp.drawText(line, { x: MARGIN, y: ty, size: 22, font: helvB, color: DARK });
          ty -= 26;
        }

        dp.drawLine({ start: { x: MARGIN, y: PAGE_H - barH - 20 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - barH - 20 }, thickness: 2, color: GOLD });

        const impiLogoSmall = scaleToFit(impiLogo, 130, 60);
        dp.drawImage(impiLogo, {
          x: (PAGE_W - impiLogoSmall.width) / 2,
          y: (PAGE_H - barH - 20) / 2 - impiLogoSmall.height / 2 + 40,
          width: impiLogoSmall.width,
          height: impiLogoSmall.height,
          opacity: 0.15,
        });
      }
    }

    // ---------------- Footer stamp on every page ----------------
    const complianceLine = 'IMPI RMS (Pty) Ltd | 10 Kosmos Crescent, Rynoue AH, Roodeplaat, Pretoria | 012 543 0640 | info@impi-secure.co.za';
    allPages.forEach((page, idx) => {
      const pageNum = idx + 1;
      const isCover = idx === 0;
      const isDivider = sectionPlan.some((s) => s.dividerPage === page);
      const isToc = tocPages.includes(page);
      const isLetter = letterPage === page;
      const isSchedule = schedulePages.includes(page);

      if (isCover || isDivider || isToc || isLetter || isSchedule) {
        page.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: PAGE_W - MARGIN, y: 40 }, thickness: 1, color: GOLD });
        page.drawText(complianceLine, { x: MARGIN, y: 28, size: 6.5, font: helv, color: GREY });
        const evLabel = eventName;
        page.drawText(evLabel, { x: MARGIN, y: 18, size: 7, font: helvB, color: DARK });
        const pn = `Page ${pageNum} of ${totalPages}`;
        const pnW = helv.widthOfTextAtSize(pn, 8);
        page.drawText(pn, { x: PAGE_W - MARGIN - pnW, y: 18, size: 8, font: helv, color: DARK });
      } else {
        // light-touch stamp only, so we don't visually alter client/official source documents
        const pn = `${pageNum} / ${totalPages}`;
        const size = 7;
        const pnW = helv.widthOfTextAtSize(pn, size);
        page.drawRectangle({ x: PAGE_W - 14 - pnW, y: 10, width: pnW + 8, height: 12, color: WHITE, opacity: 0.6 });
        page.drawText(pn, { x: PAGE_W - 10 - pnW, y: 13, size, font: helv, color: GREY });
      }
    });

    // ---------------- Outline / bookmarks ----------------
    // Two-level bookmark tree: grouped sections get a parent "Section X" bookmark
    // (jumping to the divider) with each sub-document nested underneath it
    // (jumping straight to that document). Single-document sections stay flat,
    // exactly like before.
    try {
      const context = outDoc.context;
      const topRefs = [];

      if (isOutstanding && letterPage) {
        const letterDict = context.obj({
          Title: PDFLib.PDFString.of('Transmittal Letter'),
          Dest: [letterPage.ref, PDFName.of('XYZ'), null, null, null],
        });
        topRefs.push(context.register(letterDict));
      }
      if (isOutstanding && schedulePages.length) {
        const schedDict = context.obj({
          Title: PDFLib.PDFString.of('Schedule of Outstanding Items'),
          Dest: [schedulePages[0].ref, PDFName.of('XYZ'), null, null, null],
        });
        topRefs.push(context.register(schedDict));
      }

      for (const sec of sectionPlan) {
        if (sec.items.length > 1) {
          const parentDict = context.obj({
            Title: PDFLib.PDFString.of(`Section ${sec.groupKey}`),
            Dest: [sec.dividerPage.ref, PDFName.of('XYZ'), null, null, null],
          });
          const parentRef = context.register(parentDict);
          const childRefs = sec.items.map((item) => {
            const childDict = context.obj({
              Title: PDFLib.PDFString.of(`${item.sectionNumber}. ${item.title}`),
              Dest: [item.firstContentPage.ref, PDFName.of('XYZ'), null, null, null],
            });
            return context.register(childDict);
          });
          for (let i = 0; i < childRefs.length; i++) {
            const cd = context.lookup(childRefs[i]);
            cd.set(PDFName.of('Parent'), parentRef);
            if (i > 0) cd.set(PDFName.of('Prev'), childRefs[i - 1]);
            if (i < childRefs.length - 1) cd.set(PDFName.of('Next'), childRefs[i + 1]);
          }
          parentDict.set(PDFName.of('First'), childRefs[0]);
          parentDict.set(PDFName.of('Last'), childRefs[childRefs.length - 1]);
          parentDict.set(PDFName.of('Count'), context.obj(childRefs.length));
          topRefs.push(parentRef);
        } else {
          const item = sec.items[0];
          const dict = context.obj({
            Title: PDFLib.PDFString.of(`${item.sectionNumber}. ${item.title}`),
            Dest: [sec.dividerPage.ref, PDFName.of('XYZ'), null, null, null],
          });
          topRefs.push(context.register(dict));
        }
      }
      for (let i = 0; i < topRefs.length; i++) {
        const dict = context.lookup(topRefs[i]);
        if (i > 0) dict.set(PDFName.of('Prev'), topRefs[i - 1]);
        if (i < topRefs.length - 1) dict.set(PDFName.of('Next'), topRefs[i + 1]);
      }
      const rootDict = context.obj({
        Type: 'Outlines',
        First: topRefs[0],
        Last: topRefs[topRefs.length - 1],
        Count: topRefs.length,
      });
      const rootRef = context.register(rootDict);
      topRefs.forEach((ref) => context.lookup(ref).set(PDFName.of('Parent'), rootRef));
      outDoc.catalog.set(PDFName.of('Outlines'), rootRef);
    } catch (e) {
      // Bookmarks are a nice-to-have; never fail the whole export because of them.
      console.warn('Could not build outline/bookmarks:', e);
    }

    const bytes = await outDoc.save();
    const flatSummary = [];
    for (const sec of sectionPlan) {
      if (sec.items.length > 1) {
        for (const item of sec.items) {
          flatSummary.push({ sectionNumber: item.sectionNumber, title: item.title, groupedUnder: `Section ${sec.groupKey}`, pageNumber: pageNumberOf.get(item.firstContentPage) });
        }
      } else {
        const item = sec.items[0];
        flatSummary.push({ sectionNumber: item.sectionNumber, title: item.title, groupedUnder: null, pageNumber: pageNumberOf.get(sec.dividerPage) });
      }
    }
    return { bytes, totalPages, sectionPlan: flatSummary };
  }

  return { generateBinder };
});
