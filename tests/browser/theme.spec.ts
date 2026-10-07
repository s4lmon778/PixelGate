import { test, expect } from '@playwright/test';

test('appearance follows the system, overrides it, and persists after reload', async ({
  page,
  browserName,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./');
  const root = page.locator('html');
  const appearance = page.getByRole('button', {
    name: 'Appearance',
    exact: true,
  });
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await appearance.click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(3);
  await expect(
    page.getByRole('menuitemradio', { name: 'System' }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click();
  await expect(root).toHaveCSS('color-scheme', 'light');
  await expect(page.locator('body')).toHaveCSS(
    'background-color',
    'rgb(245, 247, 250)',
  );
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(root).toHaveCSS('color-scheme', 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await appearance.click();
  await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('body')).toHaveCSS(
    'background-color',
    'rgb(18, 26, 38)',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await appearance.click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/theme-dark-${browserName}.png`,
    fullPage: true,
  });
  await page.getByRole('menuitemradio', { name: 'System' }).click();
  await expect(root).toHaveCSS('color-scheme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveCSS('color-scheme', 'dark');
});

test('appearance menu supports keyboard navigation, dismissal, and unavailable preference storage', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'pixelgate-theme')
        throw new DOMException('Blocked', 'SecurityError');
      return original.call(this, key);
    };
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'pixelgate-theme')
        throw new DOMException('Blocked', 'SecurityError');
      write.call(this, key, value);
    };
  });
  await page.goto('./');
  const button = page.getByRole('button', { name: 'Appearance', exact: true });
  await button.focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('menuitemradio', { name: 'System' }),
  ).toBeFocused();
  await page.keyboard.press('Home');
  await expect(
    page.getByRole('menuitemradio', { name: 'Light', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(button).toBeFocused();
  await button.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await page
    .getByRole('heading', {
      name: 'Transfer files between devices',
      exact: true,
    })
    .click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await button.click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
