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


  function ellipsize(text, font, size, maxW) {
    let t = String(text == null ? '' : text);
    if (font.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > maxW) t = t.slice(0, -1);
    return t + '...';
  }

  // Shared branded header for inner pages (TOC, schedule/checklist): dark band,
  // red edge block, gold underline, heading in white and the IMPI logo on a white plate.
  function drawPageHeader(page, impiLogo, helvB, heading, kicker) {
    const h = 86;
    page.drawRectangle({ x: 0, y: PAGE_H - h, width: PAGE_W, height: h, color: DARK });
    page.drawRectangle({ x: 0, y: PAGE_H - h, width: 12, height: h, color: RED });
    page.drawRectangle({ x: 0, y: PAGE_H - h - 4, width: PAGE_W, height: 4, color: GOLD });
    if (kicker) page.drawText(kicker, { x: MARGIN, y: PAGE_H - 34, size: 8, font: helvB, color: GOLD });
    const size = fitTitleSize(heading, helvB, PAGE_W - 2 * MARGIN - 140, 17, 11);
    page.drawText(heading, { x: MARGIN, y: PAGE_H - 58, size, font: helvB, color: WHITE });
    drawLogoPlate(page, impiLogo, PAGE_W - MARGIN - 112, PAGE_H - h + 17, 112, 52);
  }

  function drawLogoPlate(page, impiLogo, x, y, w, h) {
    page.drawRectangle({ x, y, width: w, height: h, color: WHITE });
    const d = scaleToFit(impiLogo, w - 12, h - 12);
    page.drawImage(impiLogo, { x: x + (w - d.width) / 2, y: y + (h - d.height) / 2, width: d.width, height: d.height });
  }

  function drawTopStripe(page) {
    page.drawRectangle({ x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8, color: RED });
    page.drawRectangle({ x: 0, y: PAGE_H - 11, width: PAGE_W, height: 3, color: GOLD });
  }

  async function generateBinder(opts) {
    const {
      submissionType = 'joc', // 'joc' | 'outstanding' | 'liquor'
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
      // Liquor-application-only fields
      municipality = '',
      licensingAuthority = '',
      licenceType = '',
      applicationRef = '',
      checklistItems = [], // [{ itemText, sectionRef }]
    } = opts;

    const isOutstanding = submissionType === 'outstanding';
    const isLiquor = submissionType === 'liquor';
    const hasLetter = isOutstanding || isLiquor;
    const scheduleItems = isLiquor ? checklistItems : outstandingItems;
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
    drawTopStripe(cover);
    const logoDim = scaleToFit(impiLogo, 110, 48);
    cover.drawImage(impiLogo, {
      x: MARGIN,
      y: PAGE_H - MARGIN - logoDim.height,
      width: logoDim.width,
      height: logoDim.height,
    });
    const webTxt = 'www.impi-secure.co.za';
    cover.drawText(webTxt, { x: PAGE_W - MARGIN - helv.widthOfTextAtSize(webTxt, 8), y: PAGE_H - MARGIN - 12, size: 8, font: helv, color: GREY });

    // ---- Title band ----
    const bandTop = PAGE_H - MARGIN - 48 - 18;
    const bandH = 132;
    const bandBottom = bandTop - bandH;
    cover.drawRectangle({ x: 0, y: bandBottom, width: PAGE_W, height: bandH, color: DARK });
    cover.drawRectangle({ x: 0, y: bandBottom, width: 14, height: bandH, color: RED });
    cover.drawRectangle({ x: 0, y: bandBottom - 4, width: PAGE_W, height: 4, color: GOLD });

    const title = isLiquor ? 'LIQUOR LICENCE APPLICATION' : isOutstanding ? 'OUTSTANDING DOCUMENTATION SUBMISSION' : 'JOC PRESENTATION FILE';
    const kicker = isLiquor ? 'LICENCE APPLICATION DOCUMENTATION' : isOutstanding ? 'RESPONSE TO OUTSTANDING ITEMS' : 'EVENT SAFETY & SECURITY DOCUMENTATION';
    cover.drawText(kicker, { x: MARGIN, y: bandTop - 28, size: 8.5, font: helvB, color: GOLD });
    const titleSize = fitTitleSize(title, helvB, PAGE_W - 2 * MARGIN, 26, 15);
    cover.drawText(title, { x: MARGIN, y: bandTop - 62, size: titleSize, font: helvB, color: WHITE });
    const evSize = fitTitleSize(eventName, helvB, PAGE_W - 2 * MARGIN, 20, 11);
    cover.drawText(eventName, { x: MARGIN, y: bandTop - 98, size: evSize, font: helvB, color: GOLD });

    // ---- Detail grid (two columns) ----
    const infoCells = isLiquor
      ? [
          ['APPLICANT / CLIENT', clientName],
          ['LICENCE TYPE', licenceType],
          ['VENUE / PREMISES', venue],
          ['EVENT DATE', eventDate],
          ['MUNICIPALITY', municipality],
          ['LICENSING AUTHORITY', licensingAuthority],
          ['APPLICATION REFERENCE', applicationRef || 'N/A'],
          ['SUBMISSION DATE', effectiveSubmissionDate],
        ]
      : isOutstanding
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
    const gridTop = bandBottom - 4 - 34;
    const cellPitch = 40, cellW = 232;
    infoCells.forEach(([label, value], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const cx = MARGIN + col * 263;
      const cyy = gridTop - row * cellPitch;
      cover.drawRectangle({ x: cx, y: cyy - 17, width: 2.5, height: 26, color: RED });
      cover.drawText(label, { x: cx + 10, y: cyy + 1, size: 7.5, font: helvB, color: GREY });
      const v = String(value || 'N/A');
      const vs = fitTitleSize(v, helv, cellW - 10, 11, 8);
      cover.drawText(ellipsize(v, helv, vs, cellW - 10), { x: cx + 10, y: cyy - 13, size: vs, font: helv, color: DARK });
    });
    const gridRows = Math.ceil(infoCells.length / 2);
    const gridBottom = gridTop - (gridRows - 1) * cellPitch - 20;

    // ---- Document control panel (bottom) ----
    const panelX = MARGIN, panelY = 56, panelW = PAGE_W - 2 * MARGIN, panelH = 84;
    cover.drawRectangle({ x: panelX, y: panelY, width: panelW, height: panelH, color: LIGHT_GREY });
    cover.drawRectangle({ x: panelX, y: panelY, width: 5, height: panelH, color: RED });
    cover.drawText('DOCUMENT CONTROL', { x: panelX + 20, y: panelY + panelH - 20, size: 9, font: helvB, color: DARK });
    const dcRows = [
      [['Prepared by', ellipsize(preparedBy, helv, 9, 140)], ['Version', docVersion]],
      [['Date generated', todayStr], [hasLetter ? 'Documents submitted' : 'Total sections', hasLetter ? String(documents.length) : String(groups.length)]],
    ];
    dcRows.forEach((pair, r) => {
      pair.forEach(([label, value], c) => {
        const x = panelX + 20 + c * 245;
        const y = panelY + panelH - 42 - r * 18;
        cover.drawText(label + ':', { x, y, size: 8.5, font: helvB, color: GREY });
        cover.drawText(value, { x: x + 100, y, size: 9, font: helv, color: DARK });
      });
    });

    // ---- Client / event logo: large and centred in the open space between
    // the detail grid and the Document Control panel. ----
    const bigLogoMaxW = 340, bigLogoMaxH = 280;
    const logoAreaTop = gridBottom - 4;
    const logoAreaBottom = panelY + panelH + 16;
    const logoAreaH = Math.max(60, logoAreaTop - logoAreaBottom);
    const bigLogoBoxH = Math.min(bigLogoMaxH, logoAreaH);
    const bigLogoBoxW = bigLogoMaxW;
    const bigLogoBoxX = (PAGE_W - bigLogoBoxW) / 2;
    const bigLogoBoxY = logoAreaBottom + (logoAreaH - bigLogoBoxH) / 2;

    if (clientLogo) {
      const cDim = scaleToFit(clientLogo, bigLogoBoxW, bigLogoBoxH);
      cover.drawImage(clientLogo, {
        x: (PAGE_W - cDim.width) / 2,
        y: bigLogoBoxY + (bigLogoBoxH - cDim.height) / 2,
        width: cDim.width,
        height: cDim.height,
      });
    } else {
      drawDashedRect(cover, bigLogoBoxX, bigLogoBoxY, bigLogoBoxW, bigLogoBoxH, GREY);
      const label = 'CLIENT / EVENT LOGO';
      const w = helv.widthOfTextAtSize(label, 9);
      cover.drawText(label, { x: (PAGE_W - w) / 2, y: bigLogoBoxY + bigLogoBoxH / 2 - 4, size: 9, font: helv, color: GREY });
    }

    // ---------------- Transmittal / application cover letter (outstanding + liquor modes) ----------------
    let letterPage = null;
    if (hasLetter) {
      letterPage = outDoc.addPage([PAGE_W, PAGE_H]);
      const lp = letterPage;
      drawTopStripe(lp);
      const smallLogoDim = scaleToFit(impiLogo, 100, 44);
      lp.drawImage(impiLogo, { x: MARGIN, y: PAGE_H - MARGIN - smallLogoDim.height + 10, width: smallLogoDim.width, height: smallLogoDim.height });
      const rightLines = [
        [effectiveSubmissionDate, helvB, 10, DARK],
        ['IMPI RMS (Pty) Ltd', helv, 8, GREY],
        ['10 Kosmos Crescent, Rynoue AH, Roodeplaat, Pretoria', helv, 8, GREY],
        ['012 543 0640  |  info@impi-secure.co.za', helv, 8, GREY],
      ];
      let ry = PAGE_H - MARGIN - 2;
      for (const [t, f, sz, col] of rightLines) {
        lp.drawText(t, { x: PAGE_W - MARGIN - f.widthOfTextAtSize(t, sz), y: ry, size: sz, font: f, color: col });
        ry -= sz + 4;
      }
      lp.drawLine({ start: { x: MARGIN, y: PAGE_H - MARGIN - smallLogoDim.height - 14 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - MARGIN - smallLogoDim.height - 14 }, thickness: 1, color: GOLD });

      let ly = PAGE_H - MARGIN - smallLogoDim.height - 50;
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

      let reLine, para1, para2, para3;
      if (isLiquor) {
        const refSuffixL = applicationRef ? ` (REF: ${applicationRef.toUpperCase()})` : '';
        reLine = `RE: APPLICATION FOR ${licenceType ? licenceType.toUpperCase() + ' ' : ''}LIQUOR LICENCE – ${eventName.toUpperCase()}${refSuffixL}`;
        para1 = `We, IMPI RMS (Pty) Ltd, hereby submit on behalf of ${clientName || 'the applicant'} an application for a ${licenceType ? licenceType + ' ' : ''}liquor licence in respect of ${venue || 'the above-mentioned premises'}${municipality ? ', situated within the ' + municipality : ''}${eventDate ? `, for the event taking place on ${eventDate}` : ''}.`;
        para2 = `The supporting documentation is enclosed and is listed in the accompanying Application Document Checklist, with each requirement cross-referenced to the relevant section and page of this file. Should any further information or clarification be required, please do not hesitate to contact the undersigned.`;
        para3 = `We trust that the application is in order, and respectfully request that it be processed in accordance with the applicable legislation${licensingAuthority ? ' and the requirements of the ' + licensingAuthority : ''}.`;
      } else {
        const refSuffix = jocReference ? ` (JOC REF: ${jocReference.toUpperCase()})` : '';
        reLine = `RE: SUBMISSION OF OUTSTANDING DOCUMENTATION – ${eventName.toUpperCase()}${refSuffix}`;
        para1 = requestedDate
          ? `Further to your correspondence dated ${requestedDate}, we hereby submit the outstanding documentation requested in respect of the above-mentioned event.`
          : `Further to your correspondence regarding the above-mentioned event, we hereby submit the outstanding documentation requested.`;
        para2 = `The enclosed documents, listed in the accompanying Schedule of Outstanding Items, are submitted in satisfaction of the outstanding requirements raised. Should any further information or clarification be required, please do not hesitate to contact the undersigned.`;
        para3 = `We trust that this submission finds the outstanding matters in order, and respectfully request that the event be considered fully compliant for approval.`;
      }

      for (const line of wrapText(reLine, helvB, 11, bodyWidth)) {
        lp.drawText(line, { x: MARGIN, y: ly, size: 11, font: helvB, color: DARK });
        ly -= 16;
      }
      ly -= 14;

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
    if (hasLetter && scheduleItems.length) {
      scheduleItems.forEach((oi, idx) => {
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
        let srcDoc, copiedPages;
        try {
          srcDoc = await PDFDocument.load(docSpec.bytes, { ignoreEncryption: true });
          copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
        } catch (err) {
          throw new Error(`Problem with "${docSpec.title || 'Untitled document'}" (Section ${docSpec.sectionNumber || group.key}): this PDF could not be read. Open it, print or save it as a new PDF (or screenshot it and save as PDF), then replace it and try again. [${err.message}]`);
        }
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

    // ---------------- Draw Schedule / Checklist content ----------------
    // (deferred until now because the "Page" column needs pageNumberOf, which only
    // exists once every content page has been embedded)
    const schedHeading = isLiquor ? 'APPLICATION DOCUMENT CHECKLIST' : 'SCHEDULE OF OUTSTANDING ITEMS';
    const schedKicker = isLiquor ? (licensingAuthority ? licensingAuthority.toUpperCase() : 'LIQUOR LICENCE APPLICATION') : 'RESPONSE TO OUTSTANDING ITEMS';
    const colItemLabel = isLiquor ? 'REQUIREMENT' : 'ITEM REQUESTED';
    schedPagesRowGroups.forEach((rowsOnPage, pageIdx) => {
      const sp = schedulePages[pageIdx];
      drawPageHeader(sp, impiLogo, helvB, schedHeading, schedKicker);

      let ly = PAGE_H - schedHeaderH - schedTopPad;
      // column header bar
      sp.drawRectangle({ x: MARGIN, y: ly - 6, width: PAGE_W - 2 * MARGIN, height: 19, color: DARK });
      const hdrY = ly - 0.5;
      sp.drawText('#', { x: colNumX + 4, y: hdrY, size: 8.5, font: helvB, color: WHITE });
      sp.drawText(colItemLabel, { x: colItemX, y: hdrY, size: 8.5, font: helvB, color: WHITE });
      sp.drawText('DOCUMENT PROVIDED', { x: colDocX, y: hdrY, size: 8.5, font: helvB, color: WHITE });
      sp.drawText('REF', { x: colRefX, y: hdrY, size: 8.5, font: helvB, color: WHITE });
      sp.drawText('PAGE', { x: colPageX, y: hdrY, size: 8.5, font: helvB, color: WHITE });
      ly -= 12;

      rowsOnPage.forEach((row, i) => {
        const rowTop = ly;
        if (i % 2 === 0) {
          sp.drawRectangle({ x: MARGIN, y: rowTop - row.rowHeight, width: PAGE_W - 2 * MARGIN, height: row.rowHeight, color: LIGHT_GREY });
        }
        sp.drawRectangle({ x: MARGIN, y: rowTop - row.rowHeight, width: 2.5, height: row.rowHeight, color: row.matched ? RED : BAR_GREY });
        let textY = rowTop - schedLineH + 2;
        sp.drawText(String(row.idx), { x: colNumX + 4, y: textY, size: 10, font: helvB, color: RED });
        row.itemLines.forEach((line, li) => sp.drawText(line, { x: colItemX, y: textY - li * schedLineH, size: 10, font: helv, color: DARK }));
        row.docLines.forEach((line, li) => sp.drawText(line, { x: colDocX, y: textY - li * schedLineH, size: 10, font: helv, color: DARK }));
        sp.drawText(row.ref, { x: colRefX, y: textY, size: 10, font: helv, color: GREY });
        const targetPage = row.matched ? docRefToPage.get(row.matched) : null;
        const pageNumStr = targetPage ? String(pageNumberOf.get(targetPage) || '—') : '—';
        sp.drawText(pageNumStr, { x: colPageX, y: textY, size: 10, font: helvB, color: DARK });
        if (targetPage) {
          addLinkAnnotation(sp, { x: MARGIN, y: rowTop - row.rowHeight, w: PAGE_W - 2 * MARGIN, h: row.rowHeight }, targetPage.ref);
        }
        ly -= row.rowHeight;
      });
    });

    // ---------------- Draw TOC content ----------------
    const tocHeaderH = 90;
    const tocTopPad = 22; // breathing room between the header bar and the first row
    const rowH = 20;
    for (const tp of tocPages) {
      drawPageHeader(tp, impiLogo, helvB, 'TABLE OF CONTENTS', 'CLICK ANY ROW TO JUMP TO THAT SECTION');
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

      if (row.bold) tp.drawRectangle({ x: MARGIN, y: rowY, width: 3, height: rowH, color: GOLD });
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
      dp.drawRectangle({ x: 0, y: PAGE_H - barH, width: PAGE_W, height: barH, color: DARK });
      dp.drawRectangle({ x: 0, y: PAGE_H - barH, width: 14, height: barH, color: RED });
      dp.drawRectangle({ x: 0, y: PAGE_H - barH - 5, width: PAGE_W, height: 5, color: GOLD });
      drawLogoPlate(dp, impiLogo, PAGE_W - MARGIN - 112, PAGE_H - barH + 29, 112, 52);
      const titleMaxW = PAGE_W - 2 * MARGIN - 135;

      if (sec.items.length > 1) {
        // ---- Grouped section: header + itemised breakdown of every sub-document ----
        dp.drawText(`SECTION ${sec.groupKey}`, { x: MARGIN, y: PAGE_H - 44, size: 12, font: helvB, color: GOLD });
        const subtitle = `This section contains ${sec.items.length} documents`;
        dp.drawText(subtitle, { x: MARGIN, y: PAGE_H - 78, size: fitTitleSize(subtitle, helvB, titleMaxW, 20, 12), font: helvB, color: WHITE });

        const bigKey = sec.groupKey;
        const bkSize = fitTitleSize(bigKey, helvB, 150, 90, 30);
        dp.drawText(bigKey, { x: PAGE_W - MARGIN - helvB.widthOfTextAtSize(bigKey, bkSize), y: 70, size: bkSize, font: helvB, color: rgb(0.94, 0.94, 0.94) });

        let ly = PAGE_H - barH - 50;
        dp.drawText('CONTENTS OF THIS SECTION', { x: MARGIN, y: ly, size: 9, font: helvB, color: GREY });
        ly -= 28;
        const listRowH = 28;
        sec.items.forEach((item, i) => {
          if (i % 2 === 0) {
            dp.drawRectangle({ x: MARGIN, y: ly - 8, width: PAGE_W - 2 * MARGIN, height: listRowH - 2, color: LIGHT_GREY });
          }
          dp.drawRectangle({ x: MARGIN, y: ly - 8, width: 3, height: listRowH - 2, color: RED });
          const pageNum = pageNumberOf.get(item.firstContentPage);
          dp.drawText(item.sectionNumber, { x: MARGIN + 12, y: ly, size: 11, font: helvB, color: RED });
          const titleLines = wrapText(item.title, helv, 11, PAGE_W - 2 * MARGIN - 160);
          dp.drawText(titleLines[0] || '', { x: MARGIN + 66, y: ly, size: 11, font: helv, color: DARK });
          const pnStr = `Page ${pageNum}`;
          const pnW = helvB.widthOfTextAtSize(pnStr, 10);
          dp.drawText(pnStr, { x: PAGE_W - MARGIN - 8 - pnW, y: ly, size: 10, font: helvB, color: DARK });
          addLinkAnnotation(dp, { x: MARGIN, y: ly - 8, w: PAGE_W - 2 * MARGIN, h: listRowH }, item.firstContentPage.ref);
          ly -= listRowH;
        });
      } else {
        // ---- Single-document section ----
        const item = sec.items[0];
        dp.drawText(`SECTION ${item.sectionNumber}`, { x: MARGIN, y: PAGE_H - 44, size: 12, font: helvB, color: GOLD });
        const titleLines = wrapText(item.title, helvB, 22, titleMaxW);
        let ty = PAGE_H - 74;
        for (const line of titleLines.slice(0, 2)) {
          dp.drawText(line, { x: MARGIN, y: ty, size: 22, font: helvB, color: WHITE });
          ty -= 26;
        }
        // Oversized watermark of the section number in the open space below
        const key = String(item.sectionNumber);
        const wmSize = fitTitleSize(key, helvB, PAGE_W - 2 * MARGIN - 40, 260, 60);
        const wmW = helvB.widthOfTextAtSize(key, wmSize);
        dp.drawText(key, { x: (PAGE_W - wmW) / 2, y: (PAGE_H - barH) / 2 - wmSize * 0.3, size: wmSize, font: helvB, color: rgb(0.95, 0.95, 0.95) });
        const pn = `Document begins on page ${pageNumberOf.get(item.firstContentPage)}`;
        const pnw = helv.widthOfTextAtSize(pn, 11);
        dp.drawRectangle({ x: (PAGE_W - pnw) / 2 - 16, y: 118, width: pnw + 32, height: 1.5, color: GOLD });
        dp.drawText(pn, { x: (PAGE_W - pnw) / 2, y: 96, size: 11, font: helv, color: GREY });
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
        page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 5, color: RED });
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

      if (hasLetter && letterPage) {
        const letterDict = context.obj({
          Title: PDFLib.PDFString.of(isLiquor ? 'Application Cover Letter' : 'Transmittal Letter'),
          Dest: [letterPage.ref, PDFName.of('XYZ'), null, null, null],
        });
        topRefs.push(context.register(letterDict));
      }
      if (hasLetter && schedulePages.length) {
        const schedDict = context.obj({
          Title: PDFLib.PDFString.of(isLiquor ? 'Application Document Checklist' : 'Schedule of Outstanding Items'),
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
