import { Command } from 'commander';
import { loadConfig, maskConfig } from './config.js';
import { runBackups } from './backup/index.js';
import { log } from './util/log.js';

const program = new Command();

program
  .name('mehen')
  .description('Server-side ops agent for DigitalEmpire — backup, scan, health.')
  .version('0.1.0')
  .option('-c, --config <path>', 'Path to config file', '/etc/abydos-ops.env');

program
  .command('backup')
  .description('Back up configured databases (pg_dump + gzip + offsite + report)')
  .option('--db <database>', 'Limit run to one or more DBs (repeatable)', collect, [])
  .option('--dry-run', 'Print the plan without dumping/uploading', false)
  .action(async (opts: { db: string[]; dryRun: boolean }) => {
    const config = loadConfig({ path: program.opts().config as string });
    const result = await runBackups({
      config,
      databases: opts.db.length ? opts.db : undefined,
      dryRun: opts.dryRun,
    });
    if (result.failedCount > 0) {
      process.exit(2);
    }
    if (result.partialCount > 0) {
      process.exit(1);
    }
    process.exit(0);
  });

program
  .command('scan')
  .description('Run security scan modules (PR-4 — not implemented yet)')
  .action(() => {
    log.info('mehen scan: not implemented yet (lands with chriscase/DigitalEmpire#105 PR-4)');
    process.exit(78); // EX_CONFIG-ish; signals "feature not configured"
  });

program
  .command('health')
  .description('Probe configured /api/health endpoints (PR-5 — not implemented yet)')
  .action(() => {
    log.info('mehen health: not implemented yet (lands with chriscase/DigitalEmpire#105 PR-5)');
    process.exit(78);
  });

program
  .command('config')
  .description('Print the loaded config (with secrets masked)')
  .action(() => {
    const config = loadConfig({ path: program.opts().config as string });
    process.stdout.write(JSON.stringify(maskConfig(config), null, 2) + '\n');
  });

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await program.parseAsync(argv);
}

// When this module is invoked directly (e.g. via the bin shim), run main()
// and let unhandled errors surface as non-zero exit.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    log.error('mehen aborted', { error: (err as Error).message });
    process.exit(1);
  });
}
