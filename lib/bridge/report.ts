import { isVerified, type RecordFile } from './model';
export function report(records: RecordFile[], format: 'json' | 'csv' | 'txt') {
  const rows = records.map((f) => ({
    path: f.relativePath,
    bytes: f.size,
    sha256: f.sha256,
    status: f.phase,
    verificationScope: f.scope,
    sourceModifiedAt: f.modified,
    filesystemModifiedTime: 'not preserved by browser writers',
    destination: f.destinationPath ?? '',
    downloadedCopy:
      f.downloaded && f.scope === 'browser' ? 'verification pending' : '',
    appHandoff: f.shared
      ? 'handed to save/share sheet; confirm save in target app'
      : '',
    appCopy: f.shared && f.scope === 'browser' ? 'verification pending' : '',
    error: f.error ?? '',
  }));
  if (format === 'json')
    return JSON.stringify(
      {
        product: 'PixelGate',
        version: 1,
        exportedAt: new Date().toISOString(),
        files: rows,
      },
      null,
      2,
    );
  if (format === 'csv') {
    const columns = [
      'path',
      'bytes',
      'sha256',
      'status',
      'verificationScope',
      'sourceModifiedAt',
      'filesystemModifiedTime',
      'destination',
      'downloadedCopy',
      'appHandoff',
      'appCopy',
      'error',
    ] as const;
    // Neutralize spreadsheet formulas as well as quoting CSV delimiters.
    const escape = (v: unknown) => {
      const s = String(v);
      return `"${(/^[=+\-@\t\r]/.test(s) ? "'" : '') + s.replaceAll('"', '""')}"`;
    };
    return [
      columns.join(','),
      ...rows.map((row) => columns.map((k) => escape(row[k])).join(',')),
    ].join('\r\n');
  }
  return (
    `PixelGate Transfer Report\n${new Date().toISOString()}\n\n${records.filter(isVerified).length} / ${records.length} copies verified\nVerification scope is listed per file. Downloaded copies and app saves require a separate readback check.\n\n` +
    rows
      .map(
        (r) =>
          `${r.path}\n${r.bytes} bytes | ${r.status} | ${r.verificationScope}\nSHA-256: ${r.sha256}${r.appHandoff ? `\nApp: ${r.appHandoff}${r.appCopy ? ` | ${r.appCopy}` : ''}` : ''}${r.error ? `\n${r.error}` : ''}`,
      )
      .join('\n\n')
  );
}
export function downloadReport(
  records: RecordFile[],
  format: 'json' | 'csv' | 'txt',
) {
  const url = URL.createObjectURL(
    new Blob([report(records, format)], {
      type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `PixelGate-${new Date().toISOString().slice(0, 10)}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
