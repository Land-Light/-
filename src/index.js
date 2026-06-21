import { loadSchedules } from './config.js';
import { runApply } from './run.js';

function parseArgs(argv) {
  const args = { dryRun: false, csv: 'data/schedules.csv' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--csv') args.csv = argv[++i];
    else if (a.startsWith('--csv=')) args.csv = a.slice('--csv='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const schedules = loadSchedules(args.csv);
  const res = await runApply(schedules, { dryRun: args.dryRun });
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
