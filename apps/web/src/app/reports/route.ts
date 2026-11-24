import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

// Directory of k6 summaries written by load-tests (mounted read-only into the container).
const DIR = process.env.LOAD_RESULTS_DIR ?? path.join(process.cwd(), '../../load-tests/results');

export async function GET() {
  try {
    const files = (await readdir(DIR)).filter((f) => f.endsWith('-latest.json')).sort();
    const reports = [];
    for (const f of files) {
      try { reports.push(JSON.parse(await readFile(path.join(DIR, f), 'utf8'))); } catch { /* skip unreadable file */ }
    }
    return Response.json({ reports });
  } catch {
    return Response.json({ reports: [] }); // directory missing = no tests run yet
  }
}
