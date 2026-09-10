import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const output = '../benchmarks/results/note-images';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const uploads = new Map();
let exports = 0;
let uploadRequests = 0;
let failExport = false;
let page;
let note = { note_id: 'image-check', title: 'Sketch export check', body_md: '', note_type: 'freeform', source_type: 'scope', source_ref: 'All indexed papers', source_title: 'All indexed papers', selected_text: '', tags: [], folder_id: 'default', attachments: [], notion_page_id: '', notion_dirty: false };
try {
  page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.on('pageerror', error => errors.push(error.message));
  const picture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#18bba0'; ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = '#fff'; ctx.fillRect(15, 20, 30, 40);
    return canvas.toDataURL('image/png');
  });
  const common = { angle: 0, strokeColor: '#d49827', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1234, version: 1, versionNonce: 100, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
  const scene = {
    elements: [
      { ...common, id: 'box', type: 'rectangle', x: 20, y: 20, width: 300, height: 170, index: 'a0' },
      { ...common, id: 'picture', type: 'image', x: 45, y: 50, width: 120, height: 80, index: 'a1', fileId: 'embedded', status: 'saved', scale: [1, 1], crop: null },
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: { embedded: { id: 'embedded', dataURL: picture, mimeType: 'image/png', created: 1, lastRetrieved: 1 } },
  };
  const draft = { body: 'A diagram with an embedded picture.', sketch: scene, attachments: [{ id: 'photo', kind: 'image', name: 'Photo.png', dataUrl: picture, createdAt: 'today' }] };
  await page.addInitScript(draft => {
    if (!localStorage.getItem('note-image-test-seeded')) {
      for (const scope of ['All indexed papers', 'all-papers', 'all papers']) localStorage.setItem(`researchmind.workspace-note:${scope}`, JSON.stringify(draft));
      localStorage.setItem('note-image-test-seeded', 'yes');
      localStorage.setItem('researchmind.workspace-notes-migrated', 'true');
    }
  }, draft);
  await page.route(/\/api\/|127\.0\.0\.1:8002\//, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    let body = {};
    if (path === '/health') body = { status: 'ok' };
    else if (path === '/notes/image-check' && request.method() === 'PATCH') { note = { ...note, ...request.postDataJSON() }; body = { note }; }
    else if (path === '/notes/image-check') body = { note };
    else if (path === '/notes/image-check/attachments') {
      uploadRequests++;
      const attachment = request.postDataJSON();
      uploads.set(attachment.client_id, attachment);
      note.attachments = [...uploads].map(([id, value]) => ({ attachment_id: id, client_id: id, kind: value.kind, name: value.name, has_scene: !!value.scene }));
      body = { attachment: { attachment_id: attachment.client_id } };
    } else if (path.startsWith('/notes/attachments/') && path.endsWith('/scene')) {
      // SQLite serializes attachment scenes with sorted object keys.
      body = JSON.parse(JSON.stringify({ scene: uploads.get(path.split('/')[3])?.scene }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
    } else if (path === '/notes/image-check/export-notion') {
      if (failExport) { await route.fulfill({ status: 502, json: { detail: "Could not export attachment 'Current sketch.png': upload interrupted" } }); return; }
      assert.equal(uploads.has('workspace-canvas'), true, 'Export requested without canvas PNG');
      exports++;
      body = { note, warnings: [], updated: exports > 1, page_id: 'mock-page', url: 'https://notion.so/mock-page' };
    } else if (path === '/notes') body = { notes: [note] };
    else if (path === '/notes/folders') body = { folders: [{ folder_id: 'default', name: 'All notes' }] };
    else if (path === '/notes/notion/targets') body = { targets: [{ target_id: 'test', name: 'Test database', database_id: 'test-db' }] };
    else if (path === '/notes/migrate-workspace') body = { imported: 0 };
    else if (path === '/clusters') body = { clusters: [], documents: [] };
    else if (path === '/articles') body = { articles: [] };
    else if (path === '/articles/domains') body = { domains: [] };
    else if (path === '/chat/sessions' || path === '/agent/sessions') body = { sessions: [] };
    await route.fulfill({ json: body });
  });
  await page.goto(`${process.env.APP_URL || 'http://127.0.0.1:5175'}/app`);
  await page.getByTitle('Export this note to Notion (saves first)').click();
  await page.getByText('Created a Notion page.', { exact: true }).waitFor();
  assert.equal(uploads.size, 2);
  assert.equal(uploadRequests, 2, 'Unchanged saved sketch was unnecessarily rendered/uploaded again');
  const canvas = uploads.get('workspace-canvas');
  const png = Buffer.from(canvas.data_url.split(',')[1], 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  await writeFile(output + '/exported-sketch.png', png);
  const imageCheck = await page.evaluate(async dataUrl => {
    const image = new Image(); image.src = dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);
    let greenPixels = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 50 && data[i + 1] > 150 && data[i + 1] < 210 && data[i + 2] > 120 && data[i + 2] < 190) greenPixels++;
    return { width: image.width, height: image.height, greenPixels };
  }, canvas.data_url);
  assert.ok(imageCheck.greenPixels > 500, 'Embedded picture missing from exported sketch');
  await page.screenshot({ path: output + '/saved-images.png' });
  // A newly added picture after reopening an existing note must be uploaded.
  await page.evaluate(picture => {
    for (const key of Object.keys(localStorage).filter(key => key.startsWith('researchmind.workspace-note:'))) {
      const draft = JSON.parse(localStorage.getItem(key));
      draft.attachments.push({ id: 'new-photo', kind: 'image', name: 'New photo.png', dataUrl: picture, createdAt: 'later' });
      localStorage.setItem(key, JSON.stringify(draft));
    }
  }, picture);
  await page.reload();
  await page.getByTitle('Export this note to Notion (saves first)').click();
  await page.getByText('Updated the Notion page.', { exact: true }).waitFor();
  assert.equal(uploads.size, 3);
  assert.equal(exports, 2);
  assert.equal(uploadRequests, 5, 'Reopening should retry each of the three images once');
  failExport = true;
  await page.getByTitle('Export this note to Notion (saves first)').click();
  await page.getByText(/Notion export failed: Could not export attachment/).waitFor();
  assert.equal(exports, 2);
  // Repair a legacy library note that only has editable sketch JSON.
  failExport = false;
  uploads.delete('workspace-canvas');
  note.attachments = note.attachments.filter(item => item.client_id !== 'workspace-canvas');
  await page.locator('.rm-nav-button').filter({ hasText: /^Notes$/ }).click();
  await page.getByTitle('Export this note to Notion', { exact: true }).click();
  await page.getByText(/Updated the Notion page for/).waitFor();
  assert.equal(uploads.has('workspace-canvas'), true);
  assert.equal(exports, 3);
  assert.deepEqual(errors, []);
  await writeFile(output + '/checks.json', JSON.stringify({ realPng: true, embeddedPicture: imageCheck, pngBytes: png.length, attachmentCountAfterReload: uploads.size, successfulMockExports: exports, legacyLibrarySketchRepaired: true, failureShown: true, errors }, null, 2));
  console.log('PASS: real sketch PNG includes embedded picture; new image uploads after reopen; no duplicate attachments; failed export shown. Notion API mocked.');
} catch (error) {
  console.log('Page errors:', errors);
  console.log((await page?.locator('body').innerText())?.slice(0, 1800));
  await page?.screenshot({ path: output + '/failure.png' });
  throw error;
} finally { await browser.close(); }
