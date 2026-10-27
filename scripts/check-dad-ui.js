'use strict';

// Optional browser gate. Reuses an installed Playwright/Playwright Core module;
// all writes and mocked video checks are confined to the disposable fixture.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.VOIDLING_PLAYWRIGHT_PATH || 'playwright');
const { dadFixture } = require('../test-support/dad-fixture');

async function main() {
  const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'voidling-dad-ui-'));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const fixture = await dadFixture();
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      const click = (selector, label) => page.locator(selector).getByRole('button', { name: label, exact: true }).click();
      const item = (selector, label) => page.locator(`${selector} article`).filter({ has: page.getByRole('heading', { name: label, exact: true }) });
      async function message(selector, expected) {
        await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent.includes(expected), { selector, expected });
      }
      try {
        await page.goto(`${fixture.origin}/dad`);
        await page.locator('#password').fill(fixture.password);
        await click('#loginForm', 'Unlock');
        await page.locator('#dashboard').waitFor({ state: 'visible' });
        assert.deepEqual(await page.locator('#dashboard > section > h2').allTextContents(), ['Games', 'Platforms', 'Guides']);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

        await item('#approvedGameList', 'Test Gmae').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#newGameName').fill('Cancelled Game');
        await click('#gameForm', 'Cancel');
        assert.equal(await item('#approvedGameList', 'Test Gmae').count(), 1);
        await item('#approvedGameList', 'Test Gmae').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#newGameName').fill('x');
        await click('#gameForm', 'Save changes');
        await message('#gameMessage', 'between 2 and 100');
        assert.equal(await page.locator('#cancelGameButton').isVisible(), true);
        await page.locator('#newGameName').fill('Test Game');
        await click('#gameForm', 'Save changes');
        await message('#gameMessage', 'Saved Test Game');
        assert.match(await page.locator('#requestList').innerText(), /Test Game/);

        await item('#platformList', 'Roblox').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#platformName').fill('Cancelled Platform');
        await click('#platformForm', 'Cancel');
        await item('#platformList', 'Roblox').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#platformName').fill('ROBLOX');
        await click('#platformForm', 'Save changes');
        await message('#platformMessage', 'Saved platform ROBLOX');
        assert.match(await page.locator('#requestList').innerText(), /ROBLOX/);
        await item('#platformList', 'ROBLOX').getByRole('button', { name: 'Remove', exact: true }).click();
        await message('#platformMessage', 'Move or remove');
        await page.locator('#platformName').fill('Desktop');
        await click('#platformForm', 'Add platform');
        await message('#platformMessage', 'Saved platform Desktop');
        await item('#platformList', 'Desktop').getByRole('button', { name: 'Remove', exact: true }).click();
        await message('#platformMessage', 'Removed platform Desktop');

        await item('#pinList', 'Old Guide').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#guide').fill('Cancelled Guide');
        await click('#pinForm', 'Cancel');
        assert.equal(await item('#pinList', 'Old Guide').count(), 1);
        await item('#pinList', 'Old Guide').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#guide').fill('Correct Guide');
        await page.locator('#videoUrl').fill('https://example.com/unsafe');
        await click('#pinForm', 'Save changes');
        await message('#approvalMessage', 'canonical YouTube');
        await page.locator('#videoUrl').fill('https://youtu.be/SaPy5eZrv34');
        await click('#pinForm', 'Save changes');
        await message('#approvalMessage', 'Saved Correct Guide');
        assert.equal(await item('#pinList', 'Old Guide').count(), 0);
        assert.equal(await item('#requestList', 'Correct Guide').count(), 1);
        assert.deepEqual(fixture.enqueued, []);

        await page.locator('#guide').fill('New Guide');
        await page.locator('#videoUrl').fill('https://youtu.be/SaPy5eZrv34');
        await click('#pinForm', 'Pre-Approve');
        await message('#approvalMessage', 'Saved New Guide');
        assert.equal(await item('#pinList', 'New Guide').count(), 1);
        assert.deepEqual(fixture.enqueued, []);
        await item('#requestList', 'Correct Guide').getByRole('button', { name: 'Pre-Approve', exact: true }).click();
        assert.equal(await page.locator('#videoUrl').inputValue(), 'https://www.youtube.com/watch?v=SaPy5eZrv34');
        await click('#pinForm', 'Pre-Approve');
        await message('#approvalMessage', 'Saved Correct Guide');

        await item('#gameRequestList', 'Kid Game').getByRole('button', { name: 'Approve game' }).click();
        await message('#gameMessage', 'Approved Kid Game');
        assert.equal(await page.locator('#gameRequestList article').count(), 0);
        assert.equal(await item('#approvedGameList', 'Kid Game').count(), 1);
        await page.getByText('Game Request History', { exact: true }).click();
        assert.match(await item('#gameHistoryList', 'Kid Game').innerText(), /APPROVED|approved/);
        assert.match(await page.locator('#requestHistory').innerText(), /REQUESTED - Test Gmae - Old Guide/);

        await item('#requestList', 'Correct Guide').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#editGuide').fill('Cancelled Entry');
        await click('#editForm', 'Cancel');
        assert.equal(await item('#requestList', 'Correct Guide').count(), 1);
        await item('#requestList', 'Correct Guide').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#editGuide').fill('Corrected Entry');
        await click('#editForm', 'Save changes');
        await message('#approvalMessage', 'Renamed the library entry to Corrected Entry');
        assert.equal(await item('#pinList', 'Corrected Entry').count(), 1);
        await page.reload();
        await page.locator('#dashboard').waitFor({ state: 'visible' });
        assert.equal(await item('#approvedGameList', 'Test Game').count(), 1);
        assert.equal(await page.locator('#gameRequestList article').count(), 0);
        assert.match(await page.locator('#requestHistory').innerText(), /Old Guide/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
        await page.locator('#guidesSection').screenshot({ path: path.join(screenshots, `${name}-guides.png`) });

        await item('#requestList', 'Corrected Entry').getByRole('button', { name: 'Remove', exact: true }).click();
        await message('#approvalMessage', 'Removed Corrected Entry');
        assert.equal(await page.locator('#requestList article').count(), 0);
        assert.match(await page.locator('#requestHistory').innerText(), /REQUESTED - Test Gmae - Old Guide/);
        await item('#pinList', 'New Guide').getByRole('button', { name: 'Edit', exact: true }).click();
        await click('#pinForm', 'Check and approve');
        await message('#approvalMessage', 'downloading now');
        assert.equal(fixture.enqueued.length, 1);
        await page.getByRole('button', { name: 'Lock page', exact: true }).click();
        await page.locator('#loginPanel').waitFor({ state: 'visible' });
        assert.deepEqual(errors, []);
        assert.deepEqual(fixture.errors, []);
        console.log(`PASS ${name}: three sections, add/edit/save/cancel/error feedback, approval/history, pre-approval/download, reload, removal, no overflow or page errors`);
      } finally { await page.close(); await fixture.close(); }
    }
    console.log(`Screenshots: ${screenshots}`);
    console.log('Video metadata and downloads were stubbed; production data was not used.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
