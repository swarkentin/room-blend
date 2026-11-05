'use strict';

// Helpers for the host's collapsible music-source settings.
// Always reopen after actions that may rerender the source panel.
async function openSourceSettings(page) {
  const details = page.locator('#sp details.source-settings');
  await details.waitFor({ state: 'attached' });
  if (!(await details.evaluate((el) => el.open))) {
    await details.locator(':scope > summary').click();
  }
  return details;
}

async function chooseSource(page, id) {
  await openSourceSettings(page);
  await page.click('#sp [data-src="' + id + '"]');
}

module.exports = { openSourceSettings, chooseSource };
