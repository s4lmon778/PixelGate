import { test, expect, chromium, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { encodePair } from '../../lib/bridge/pairing';

test('Pixel sending opens the media picker and retains the generic files picker', async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Linux; Android 9; Pixel XL) AppleWebKit/537.36 Chrome/101.0.0.0 Mobile Safari/537.36',
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() =>
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: undefined,
      }),
    );
    await page.goto('./');
    const photo = {
      name: 'Pixel-original.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('Original image selection bytes'),
    };
    const video = {
      name: 'Pixel-original.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('Original video selection bytes'),
    };
    const choosing = page.waitForEvent('filechooser');
    await page
      .getByRole('button', { name: 'Choose photos & videos', exact: true })
      .click();
    const chooser = await choosing;
    expect(chooser.isMultiple()).toBe(true);
    expect(await chooser.element().getAttribute('accept')).toBe(
      'image/*,video/*',
    );
    expect(await chooser.element().getAttribute('capture')).toBeNull();
    await chooser.setFiles([photo, video]);
    await expect(page.getByText(photo.name, { exact: true })).toBeVisible();
    await expect(page.getByText(video.name, { exact: true })).toBeVisible();
    const pickingFile = page.waitForEvent('filechooser');
    await page
      .getByRole('button', { name: 'Choose files', exact: true })
      .click();
    const files = await pickingFile;
    expect(await files.element().getAttribute('accept')).toBeNull();
    await files.setFiles({
      name: 'Document.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Unrestricted file selection'),
    });
    await expect(page.getByText('Document.txt', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole('button', { name: 'Receive files', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Save to Photos folder', exact: true }),
    ).toHaveCount(0);
    await page
      .getByText('Saving options & Photos help', { exact: true })
      .click();
    await expect(
      page.getByText(/This browser cannot choose a Photos folder/),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

async function seed(page: Page, staging: boolean | 'buffers' = true) {
  await page.goto('./');
  await expect(
    page.getByRole('button', { name: 'Receive files', exact: true }),
  ).toBeVisible();
  await page.evaluate(async (withStaging) => {
    const open = (name: string, version: number) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('files', { keyPath: 'id' });
          request.result.createObjectStore('chunks', {
            keyPath: ['fileId', 'offset'],
          });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const database = await open('pixelbridge-v1', 3);
    const content = new TextEncoder().encode('Original Unicode bytes: 旅行 🐈');
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', content)),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const records = ['a', 'b', 'c'].map((char, i) => ({
      id: char.repeat(64),
      sessionId: i === 1 ? 'session-two' : 'session-one',
      relativePath: `旅行-${i}/photo-é.txt`,
      originalName: 'photo-é.txt',
      size: content.length,
      sha256: digest,
      mimeType: 'text/plain',
      modified: 1000,
      bytes: i === 2 ? 5 : content.length,
      phase: i === 2 ? 'paused' : 'verified',
      scope: i === 2 ? 'none' : 'browser',
      updated: 1000 + i,
      localRole: 'receive',
    }));
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['files', 'history'], 'readwrite');
      for (const record of records) {
        tx.objectStore('files').put(record);
        tx.objectStore('history').put({
          ...record,
          historyKey: `receive:${record.sessionId}:${record.id}`,
        });
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    database.close();
    if (withStaging) {
      const staging = await open('pixelgate-staging-v1', 1);
      await new Promise<void>((resolve, reject) => {
        const tx = staging.transaction(['files', 'chunks'], 'readwrite');
        for (const record of records) {
          tx.objectStore('files').put({ id: record.id, size: record.bytes });
          tx.objectStore('chunks').put({
            fileId: record.id,
            offset: 0,
            bytes:
              withStaging === 'buffers'
                ? content.slice(0, record.bytes).buffer
                : new Blob([content.slice(0, record.bytes)]),
          });
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      staging.close();
    }
  }, staging);
  await page.reload();
}

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('pixelbridge-v1', 3);
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const read = (store: string) =>
      new Promise<unknown[]>((resolve) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
      });
    const records = await read('files');
    const history = await read('history');
    db.close();
    return { records, history };
  });
}

test('history clearing scopes sessions, supports cancellation, and preserves resume manifests', async ({
  page,
  browserName,
}) => {
  await seed(page, browserName !== 'webkit');
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await snapshot(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Clear history', exact: true })
    .click();
  await expect(page.locator('.file-row')).toHaveCount(3);
  await page.getByLabel('Session', { exact: true }).selectOption('session-two');
  await expect(page.locator('.file-row')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Clear history', exact: true })
    .click();
  await expect(page.locator('.file-row')).toHaveCount(2);
  expect((await snapshot(page)).records).toEqual(before.records);
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Clear history', exact: true })
    .click();
  await expect(page.locator('.file-row')).toHaveCount(0);
  expect((await snapshot(page)).records).toEqual(before.records);
  await page.reload();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Clear history', exact: true }),
  ).toBeDisabled();
  if (browserName !== 'webkit') {
    const expectedSizes = new TextEncoder().encode(
      'Original Unicode bytes: 旅行 🐈',
    ).length;
    expect(
      await page.evaluate(async () => {
        const request = indexedDB.open('pixelgate-staging-v1', 1);
        const db = await new Promise<IDBDatabase>((resolve) => {
          request.onsuccess = () => resolve(request.result);
        });
        const chunks = db.transaction('chunks').objectStore('chunks').getAll();
        const result = await new Promise<{ bytes: Blob }[]>((resolve) => {
          chunks.onsuccess = () => resolve(chunks.result);
        });
        db.close();
        return result.map((c) => c.bytes.size);
      }),
    ).toEqual([expectedSizes, expectedSizes, 5]);
  }
  await page.getByRole('button', { name: 'Transfer', exact: true }).click();
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Prepare selected files', exact: true }),
  ).toBeEnabled();
});

test('unsupported mobile capabilities keep downloads available and show truthful awake status', async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const name of ['share', 'canShare', 'wakeLock'])
      Object.defineProperty(Navigator.prototype, name, {
        configurable: true,
        value: undefined,
      });
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined });
  });
  await page.goto('./');
  await expect(
    page.getByRole('switch', { name: 'Keep screen awake' }),
  ).toBeDisabled();
  await expect(page.getByText(/Set a longer screen timeout/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Prepare selected files', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Choose folder', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Choose folder', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Choose a save folder', exact: true }),
  ).toContainText('does not grant websites direct writable-folder access');
  await expect(
    page
      .getByRole('group', { name: 'Save actions', exact: true })
      .getByRole('button', { name: 'Choose folder', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Manual download', { exact: true }),
  ).toBeVisible();
});

test('Safari keeps a folder action beside saving controls with native download-folder guidance', async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15',
  });
  try {
    await context.addInitScript(() =>
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: undefined,
      }),
    );
    const page = await context.newPage();
    await page.goto('./');
    await page
      .getByRole('button', { name: 'Receive files', exact: true })
      .click();
    const group = page.getByRole('group', {
      name: 'Save actions',
      exact: true,
    });
    await group
      .getByRole('button', { name: 'Choose folder', exact: true })
      .click();
    const guidance = page.getByRole('region', {
      name: 'Choose a save folder',
      exact: true,
    });
    await expect(guidance).toContainText('Ask for each download');
    await expect(guidance).toContainText('Safari’s save dialog');
    await expect(
      group.getByRole('button', {
        name: 'Prepare selected files',
        exact: true,
      }),
    ).toBeVisible();
    await group
      .getByRole('button', { name: 'Choose folder', exact: true })
      .click();
    await expect(guidance).toBeHidden();
  } finally {
    await context.close();
  }
});

test('save/share opens from a fresh tap, preserves bytes, handles cancel, and never claims destination verification', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'macOS WebKit nonpersistent Blob storage is not a mobile OS share-sheet test.',
  );
  await page.addInitScript(() => {
    const state = {
      cancel: true,
      allowed: true,
      calls: 0,
      activated: false,
      names: [] as string[],
      hashes: [] as string[],
    };
    Object.assign(window, { shareTest: state });
    Object.defineProperty(Navigator.prototype, 'canShare', {
      configurable: true,
      value: ({ files }: ShareData) => state.allowed && !!files?.length,
    });
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: async ({ files }: ShareData) => {
        state.calls++;
        state.activated = navigator.userActivation.isActive;
        if (state.cancel) throw new DOMException('Cancelled', 'AbortError');
        state.names = files!.map((f) => f.name);
        state.hashes = await Promise.all(
          files!.map(async (f) =>
            [
              ...new Uint8Array(
                await crypto.subtle.digest('SHA-256', await f.arrayBuffer()),
              ),
            ]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(''),
          ),
        );
      },
    });
  });
  await seed(page);
  const before = await snapshot(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  const dialog = page.getByRole('region', {
    name: 'Save received files',
    exact: true,
  });
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Prepare selected files' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Choose app or save location' }),
  ).toBeEnabled();
  const saveActions = dialog.getByRole('group', {
    name: 'Save actions',
    exact: true,
  });
  for (const name of [
    'Choose folder',
    'Choose app or save location',
    'Download verified files',
    'Select next batch',
  ])
    await expect(
      saveActions.getByRole('button', { name, exact: true }),
    ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/mobile-save-${browserName}.png`,
    fullPage: true,
  });
  await dialog
    .getByRole('button', { name: 'Choose app or save location' })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    'without a confirmed handoff',
  );
  expect((await snapshot(page)).records).toEqual(before.records);
  await page.evaluate(() => {
    (window as unknown as { shareTest: { cancel: boolean } }).shareTest.cancel =
      false;
  });
  await dialog
    .getByRole('button', { name: 'Choose app or save location' })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    'Verification pending',
  );
  await expect(
    dialog.getByRole('button', { name: 'Select next batch' }),
  ).toBeDisabled();
  await expect(dialog.getByRole('checkbox').first()).not.toBeChecked();
  const actual = await page.evaluate(
    () =>
      (
        window as unknown as {
          shareTest: {
            calls: number;
            activated: boolean;
            names: string[];
            hashes: string[];
          };
        }
      ).shareTest,
  );
  expect(actual.calls).toBe(2);
  expect(actual.activated).toBe(true);
  expect(actual.names).toEqual(['photo-é.txt', 'photo-é (2).txt']);
  const stored = (await snapshot(page)).records as {
    sha256: string;
    scope: string;
    shared?: boolean;
    phase: string;
  }[];
  expect(actual.hashes).toEqual(stored.slice(0, 2).map((r) => r.sha256));
  expect(
    stored
      .slice(0, 2)
      .every(
        (r) => r.shared && r.scope === 'browser' && r.phase === 'verified',
      ),
  ).toBe(true);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(
    page.getByText('App save verification pending', { exact: true }),
  ).toHaveCount(2);
});

test('corrupted stored files and unsupported share payloads prevent app handoff', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'See positive share fixture boundary.');
  await page.addInitScript(() => {
    Object.assign(window, { shareCalls: 0 });
    Object.defineProperty(Navigator.prototype, 'canShare', {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: () => {
        (window as unknown as { shareCalls: number }).shareCalls++;
        return Promise.resolve();
      },
    });
  });
  await seed(page);
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  const dialog = page.getByRole('region', {
    name: 'Save received files',
    exact: true,
  });
  await dialog.getByRole('button', { name: 'Prepare selected files' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'cannot share these files together',
  );
  await page.evaluate(async () => {
    const request = indexedDB.open('pixelgate-staging-v1', 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const original = await new Promise<{ bytes: Blob }>((resolve) => {
      const read = db
        .transaction('chunks')
        .objectStore('chunks')
        .get(['a'.repeat(64), 0]);
      read.onsuccess = () => resolve(read.result);
    });
    const corrupted = new Uint8Array(await original.bytes.arrayBuffer());
    corrupted[0] ^= 0xff;
    await new Promise<void>((resolve) => {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put({
        fileId: 'a'.repeat(64),
        offset: 0,
        bytes: new Blob([corrupted]),
      });
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await expect(
    dialog.getByRole('button', { name: 'Choose app or save location' }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Download verified files' }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Clear selection' }).click();
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Prepare selected files' }).click();
  await expect(dialog.getByRole('status')).toContainText('failed verification');
  await expect(
    dialog.getByRole('button', { name: 'Download verified files' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { shareCalls: number }).shareCalls,
    ),
  ).toBe(0);
});

async function installWake(page: Page, delayed = false) {
  await page.addInitScript((delay) => {
    const state = {
      requests: 0,
      releases: 0,
      deny: false,
      delay,
      pending: undefined as (() => void) | undefined,
      lock: undefined as
        | (EventTarget & { released: boolean; release: () => Promise<void> })
        | undefined,
    };
    Object.assign(window, { wakeTest: state });
    Object.defineProperty(Navigator.prototype, 'wakeLock', {
      configurable: true,
      value: {
        request: () => {
          state.requests++;
          if (state.deny)
            return Promise.reject(
              new DOMException('Low power', 'NotAllowedError'),
            );
          const lock = Object.assign(new EventTarget(), {
            released: false,
            release: async () => {
              if (!lock.released) {
                lock.released = true;
                state.releases++;
                lock.dispatchEvent(new Event('release'));
              }
            },
          });
          state.lock = lock;
          return state.delay
            ? new Promise((resolve) => {
                state.pending = () => resolve(lock);
              })
            : Promise.resolve(lock);
        },
      },
    });
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        super({ ...config, iceServers: [] });
      }
    };
  }, delayed);
}
async function pairForWake(page: Page, browserName: string) {
  await page.goto('./');
  if (browserName === 'webkit') {
    // Test WebKit's awake UI as a sender: this ephemeral macOS context cannot
    // pass the receiving storage probe. Keep that storage boundary intact.
    const other = await chromium.launch();
    try {
      const receiver = await other.newPage();
      await receiver.goto(page.url());
      const description = await receiver.evaluate(async () => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('pixelbridge-v1', { ordered: true });
        await pc.setLocalDescription(await pc.createOffer());
        return {
          type: pc.localDescription!.type,
          sdp: pc.localDescription!.sdp,
        };
      });
      await page
        .getByRole('button', { name: 'Use copy/paste pairing', exact: true })
        .click();
      await page.getByLabel('Receiver’s pairing link', { exact: true }).fill(
        encodePair({
          version: 1,
          id: crypto.randomUUID(),
          expires: Date.now() + 600000,
          description,
        }),
      );
      await page
        .getByRole('button', { name: 'Prepare sender response', exact: true })
        .click();
      await expect(
        page.getByLabel('Sender response', { exact: true }),
      ).toBeVisible({ timeout: 20000 });
    } finally {
      await other.close();
    }
    return;
  }
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Use copy/paste pairing', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Create a connection', exact: true })
    .click();
}
type WakeState = {
  requests: number;
  releases: number;
  deny: boolean;
  pending: () => void;
  lock: { release: () => Promise<void> };
};
test('keep-awake switch releases, reacquires, reports denial, and remembers off preference', async ({
  page,
  browserName,
}) => {
  await installWake(page);
  await pairForWake(page, browserName);
  await expect(
    page.getByText('Active — this screen is staying awake.', { exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const state = (window as unknown as { wakeTest: WakeState }).wakeTest;
    await state.lock.release();
  });
  await expect(
    page.getByRole('button', { name: 'Try keeping awake again' }),
  ).toBeVisible();
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByText('Active — this screen is staying awake.', { exact: true }),
  ).toBeVisible();
  const control = page.getByRole('switch', { name: 'Keep screen awake' });
  await control.click();
  await expect(control).toHaveAttribute('aria-checked', 'false');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { wakeTest: WakeState }).wakeTest.releases,
      ),
    )
    .toBe(2);
  await page.evaluate(() => {
    (window as unknown as { wakeTest: WakeState }).wakeTest.deny = true;
  });
  await control.click();
  await expect(page.getByText(/Not active —/)).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { wakeTest: WakeState }).wakeTest.deny = false;
  });
  await page.getByRole('button', { name: 'Try keeping awake again' }).click();
  await expect(
    page.getByText('Active — this screen is staying awake.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: browserName === 'webkit' ? 'Disconnect' : 'Revoke connection',
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { wakeTest: WakeState }).wakeTest.releases,
      ),
    )
    .toBe(3);
  await control.click();
  await page.reload();
  await expect(control).toHaveAttribute('aria-checked', 'false');
});

test('turning wake off while the request is pending releases the late lock', async ({
  page,
  browserName,
}) => {
  await installWake(page, true);
  await pairForWake(page, browserName);
  await expect(
    page.getByText('Requesting screen lock…', { exact: true }),
  ).toBeVisible();
  await page.getByRole('switch', { name: 'Keep screen awake' }).click();
  await page.evaluate(() =>
    (window as unknown as { wakeTest: WakeState }).wakeTest.pending(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { wakeTest: WakeState }).wakeTest.releases,
      ),
    )
    .toBe(1);
  await expect(
    page.getByText('Off — your device’s normal screen timeout applies.', {
      exact: true,
    }),
  ).toBeVisible();
});

test('unsupported sharing offers byte-exact verified downloads with pending destination verification', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Nonpersistent macOS WebKit cannot retain the Blob staging fixture.',
  );
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(Navigator.prototype, 'canShare', {
      configurable: true,
      value: undefined,
    });
  });
  await seed(page);
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  const dialog = page.getByRole('region', {
    name: 'Save received files',
    exact: true,
  });
  await dialog.getByRole('button', { name: 'Clear selection' }).click();
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Prepare selected files' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Choose app or save location' }),
  ).toHaveCount(0);
  const result = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download verified files' }).click();
  const download = await result;
  expect(download.suggestedFilename()).toBe('photo-é.txt');
  const bytes = await readFile((await download.path())!);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const expected = createHash('sha256')
    .update('Original Unicode bytes: 旅行 🐈')
    .digest('hex');
  expect(hash).toBe(expected);
  await expect(dialog.getByRole('status')).toContainText(
    'Verification pending',
  );
  const record = (
    (await snapshot(page)).records as {
      id: string;
      downloaded?: boolean;
      scope: string;
      shared?: boolean;
    }[]
  ).find((r) => r.id === 'a'.repeat(64))!;
  expect(record.downloaded).toBe(true);
  expect(record.scope).toBe('browser');
  expect(record.shared).toBeFalsy();
  await dialog.getByRole('button', { name: 'Select next batch' }).click();
  await expect(dialog.getByRole('checkbox').first()).toBeChecked();
  await expect(dialog.getByRole('checkbox').nth(1)).not.toBeChecked();
  // Preparation after downloading rereads retained staging, rather than clearing it.
  await dialog.getByRole('button', { name: 'Prepare selected files' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Download verified files' }),
  ).toBeEnabled();
});

for (const backend of ['opfs', 'indexeddb']) {
  test(`inline receiving clears ${backend} file cache, keeps partials and receipts, and supports cancellation`, async ({
    page,
    browserName,
  }) => {
    test.skip(
      backend === 'opfs' && browserName === 'webkit',
      'Ephemeral macOS WebKit does not expose durable OPFS.',
    );
    if (backend === 'indexeddb')
      await page.context().addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'storage', {
          configurable: true,
          value: {
            estimate: () => Promise.resolve({ quota: 10000000, usage: 1000 }),
          },
        });
      });
    await seed(page, browserName === 'webkit' ? 'buffers' : true);
    await page.evaluate(async (mode) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open('pixelbridge-v1', 3);
        request.onsuccess = () => resolve(request.result);
      });
      const read = db.transaction('files').objectStore('files').getAll();
      const records = await new Promise<Record<string, unknown>[]>(
        (resolve) => {
          read.onsuccess = () => resolve(read.result);
        },
      );
      records[0].scope = 'destination';
      records[1].downloaded = true;
      await new Promise<void>((resolve) => {
        const tx = db.transaction(['files', 'history'], 'readwrite');
        for (const record of records) {
          tx.objectStore('files').put(record);
          tx.objectStore('history').put({
            ...record,
            historyKey: `receive:${record.sessionId}:${record.id}`,
          });
        }
        tx.objectStore('history').put({
          ...records[0],
          sessionId: 'previous-cache-session',
          scope: 'browser',
          downloaded: true,
          updated: 1,
          historyKey: `receive:previous-cache-session:${records[0].id}`,
        });
        tx.oncomplete = () => resolve();
      });
      db.close();
      if (mode === 'opfs') {
        const root = await navigator.storage.getDirectory();
        const staging = await root.getDirectoryHandle('pixelbridge', {
          create: true,
        });
        for (const record of records) {
          const writer = await (
            await staging.getFileHandle(String(record.id), { create: true })
          ).createWritable();
          await writer.write(new Uint8Array(Number(record.bytes)));
          await writer.close();
        }
        const saved = await root.getDirectoryHandle('saved-originals', {
          create: true,
        });
        const writer = await (
          await saved.getFileHandle('original.jpg', { create: true })
        ).createWritable();
        await writer.write('Original destination bytes');
        await writer.close();
      }
    }, backend);
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('button', { name: 'Receive files', exact: true })
      .click();
    const inline = page.getByRole('region', {
      name: 'Save received files',
      exact: true,
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: /^(Export verified batch|Verify saved copies)$/,
      }),
    ).toHaveCount(0);
    await expect(inline.locator('.file-row')).toHaveCount(3);
    const otherTab = await page.context().newPage();
    await otherTab.goto('./');
    await otherTab
      .getByRole('button', { name: 'Receive files', exact: true })
      .click();
    const otherList = otherTab.getByRole('region', {
      name: 'Received files',
      exact: true,
    });
    await expect(otherList.locator('.file-row')).toHaveCount(3);
    if (backend === 'indexeddb') {
      await otherList.getByRole('checkbox').check();
      await otherTab
        .getByRole('button', { name: 'Prepare selected files', exact: true })
        .click();
      await expect(
        otherTab.getByRole('button', {
          name: 'Download verified files',
          exact: true,
        }),
      ).toBeVisible();
    }
    const before = await snapshot(page);
    const clear = inline.getByRole('button', {
      name: /^Clear verified staging/,
    });
    await expect(clear).toBeEnabled();
    page.once('dialog', (dialog) => dialog.dismiss());
    await clear.click();
    expect(await snapshot(page)).toEqual(before);
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain(
        'Confirm their downloads or app saves have finished',
      );
      void dialog.accept();
    });
    await clear.click();
    await expect(
      page.getByRole('status').filter({ hasText: 'staged copies cleared' }),
    ).toContainText('2 staged copies cleared');
    await expect(clear).toBeDisabled();
    await expect(inline.getByText(/Cache cleared/)).toHaveCount(0);
    await expect(inline.locator('.file-row')).toHaveCount(1);
    await expect(otherList.locator('.file-row')).toHaveCount(1);
    await expect(
      otherTab.getByRole('button', {
        name: 'Download verified files',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(otherTab.locator('.staging-cache-size')).toHaveText(
      `File cache: ${backend === 'opfs' ? 10 : 5} B`,
    );
    await expect(inline.getByRole('checkbox')).toHaveCount(0);
    const after = await snapshot(page);
    const records = after.records as {
      id: string;
      stagingCleared?: boolean;
      scope: string;
      downloaded?: boolean;
    }[];
    expect(records[0]).toMatchObject({
      stagingCleared: true,
      scope: 'destination',
    });
    expect(records[1]).toMatchObject({
      stagingCleared: true,
      scope: 'browser',
      downloaded: true,
    });
    expect(records[2]).toEqual(before.records[2]);
    expect(after.history).toHaveLength(4);
    const remaining = await page.evaluate(async (mode) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open('pixelgate-staging-v1', 1);
        request.onsuccess = () => resolve(request.result);
      });
      const request = db.transaction('chunks').objectStore('chunks').getAll();
      const chunks = await new Promise<
        { fileId: string; bytes: Blob | ArrayBuffer }[]
      >((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      const opfs: string[] = [];
      let original = '';
      if (mode === 'opfs') {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('pixelbridge');
        for await (const name of (
          dir as FileSystemDirectoryHandle & {
            keys(): AsyncIterableIterator<string>;
          }
        ).keys())
          opfs.push(name);
        original = await (
          await (
            await (
              await root.getDirectoryHandle('saved-originals')
            ).getFileHandle('original.jpg')
          ).getFile()
        ).text();
      }
      return {
        chunks: chunks.map((chunk) => ({
          id: chunk.fileId,
          size:
            chunk.bytes instanceof Blob
              ? chunk.bytes.size
              : chunk.bytes.byteLength,
        })),
        opfs,
        original,
      };
    }, backend);
    expect(remaining.chunks).toEqual([{ id: 'c'.repeat(64), size: 5 }]);
    await expect(page.locator('.staging-cache-size')).toHaveText(
      `File cache: ${backend === 'opfs' ? 10 : 5} B`,
    );
    if (backend === 'opfs') {
      expect(remaining.opfs).toEqual(['c'.repeat(64)]);
      expect(remaining.original).toBe('Original destination bytes');
    }
    await page.reload();
    await page
      .getByRole('button', { name: 'Receive files', exact: true })
      .click();
    await expect(page.getByText(/Cache cleared/)).toHaveCount(0);
    await expect(
      page
        .getByRole('region', { name: 'Received files', exact: true })
        .locator('.file-row'),
    ).toHaveCount(1);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.locator('.file-row')).toHaveCount(4);
    await expect(page.getByText(/Cache cleared/)).toHaveCount(3);
    await expect(page.getByRole('button', { name: /^Save photo/ })).toHaveCount(
      0,
    );
    await page.getByText('Saved-copy tools', { exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Verify exported files', exact: true }),
    ).toBeVisible();
    await otherTab.close();
  });
}

test('saved cache becomes empty even when the browser allowance estimate stays unchanged', async ({
  page,
  browserName,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'storage', {
      configurable: true,
      value: {
        estimate: () => Promise.resolve({ quota: 10000000, usage: 1000 }),
      },
    });
  });
  await seed(page, browserName === 'webkit' ? 'buffers' : true);
  await page.evaluate(async () => {
    const open = (name: string, version: number) =>
      new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open(name, version);
        request.onsuccess = () => resolve(request.result);
      });
    const db = await open('pixelbridge-v1', 3);
    await new Promise<void>((resolve) => {
      const tx = db.transaction(['files', 'history'], 'readwrite');
      const read = tx.objectStore('files').getAll();
      read.onsuccess = () => {
        for (const record of read.result) {
          if (record.phase === 'paused') {
            tx.objectStore('files').delete(record.id);
            tx.objectStore('history').delete(
              `receive:${record.sessionId}:${record.id}`,
            );
          } else {
            record.downloaded = true;
            tx.objectStore('files').put(record);
          }
        }
      };
      tx.oncomplete = () => resolve();
    });
    db.close();
    const staging = await open('pixelgate-staging-v1', 1);
    await new Promise<void>((resolve) => {
      const tx = staging.transaction(['files', 'chunks'], 'readwrite');
      tx.objectStore('files').delete('c'.repeat(64));
      tx.objectStore('chunks').delete(['c'.repeat(64), 0]);
      tx.oncomplete = () => resolve();
    });
    staging.close();
  });
  await page.reload();
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  const allowance = page.getByText(/^Browser allowance estimate:/);
  const before = await allowance.textContent();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /^Clear verified staging/ }).click();
  await expect(page.locator('.staging-cache-size')).toHaveText(
    'File cache: 0 B',
  );
  await expect(page.locator('.file-row')).toHaveCount(0);
  expect(await allowance.textContent()).toBe(before);
  const empty = await page.evaluate(async () => {
    const request = indexedDB.open('pixelgate-staging-v1', 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const counts = await Promise.all(
      ['files', 'chunks'].map(
        (store) =>
          new Promise<number>((resolve) => {
            const count = db.transaction(store).objectStore(store).count();
            count.onsuccess = () => resolve(count.result);
          }),
      ),
    );
    db.close();
    return counts;
  });
  expect(empty).toEqual([0, 0]);
  await page.reload();
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await expect(page.locator('.file-row')).toHaveCount(0);
  await expect(page.locator('.staging-cache-size')).toHaveText(
    'File cache: 0 B',
  );
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Save photo/ })).toHaveCount(
    0,
  );
});

test('sender file selection stays inside the list and limits the pending send selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('./');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles(
    Array.from({ length: 125 }, (_, i) => ({
      name: `original-${i}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`Original ${i}`),
    })),
  );
  const files = page.getByRole('region', {
    name: 'Files to send',
    exact: true,
  });
  await expect(files.getByRole('checkbox')).toHaveCount(50);
  expect(
    await files.evaluate((list) => list.scrollHeight > list.clientHeight),
  ).toBe(true);
  const pageHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  await files.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(files.getByRole('checkbox')).toHaveCount(100);
  await files.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(files.getByRole('checkbox')).toHaveCount(125);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    pageHeight,
  );
  await page
    .getByRole('button', { name: 'Clear selection', exact: true })
    .click();
  await files
    .getByRole('checkbox', { name: 'Select original-124.txt', exact: true })
    .check();
  await expect(
    page.getByText('1 selected to send', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
