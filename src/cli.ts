import { Command } from 'commander';
import { loadConfig, maskConfig } from './config.js';
import { runBackups } from './backup/index.js';
import { runScans, listAvailableModules } from './scan/index.js';
import { runHealthChecks } from './health/index.js';
import { runStorageScan } from './storage/index.js';
import { log } from './util/log.js';

const program = new Command();

program
  .name('mehen')
  .description('Server-side ops agent for DigitalEmpire — backup, scan, health.')
  .version('0.2.0')
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
    if (result.failedCount > 0) process.exit(2);
    if (result.partialCount > 0) process.exit(1);
    process.exit(0);
  });

program
  .command('scan')
  .description('Run security scan modules across configured databases')
  .option('--db <database>', 'Limit to one or more DBs (repeatable)', collect, [])
  .option('--module <name>', 'Limit to one or more modules (repeatable)', collect, [])
  .option('--list', 'List registered scan modules and exit', false)
  .option('--dry-run', 'Print the plan without connecting / running', false)
  .action(async (opts: { db: string[]; module: string[]; list: boolean; dryRun: boolean }) => {
    if (opts.list) {
      const modules = listAvailableModules();
      process.stdout.write(JSON.stringify(modules, null, 2) + '\n');
      process.exit(0);
    }
    const config = loadConfig({ path: program.opts().config as string });
    const result = await runScans({
      config,
      databases: opts.db.length ? opts.db : undefined,
      modules: opts.module.length ? opts.module : undefined,
      dryRun: opts.dryRun,
    });
    process.exit(result.errors.length > 0 ? 1 : 0);
  });

program
  .command('health')
  .description('Probe configured /api/health endpoints (set MEHEN_HEALTH_URLS)')
  .option('--url <url>', 'Override URLs to probe (repeatable)', collect, [])
  .action(async (opts: { url: string[] }) => {
    const config = loadConfig({ path: program.opts().config as string });
    const samples = await runHealthChecks({ config, urls: opts.url });
    const anyDown = samples.some((s) => !s.ok);
    process.exit(anyDown ? 1 : 0);
  });

program
  .command('storage-scan')
  .description('Walk the configured S3 bucket and report usage to DE')
  .option('--dry-run', 'Print scan plan + result without POSTing back', false)
  .action(async (opts: { dryRun: boolean }) => {
    const config = loadConfig({ path: program.opts().config as string });
    const result = await runStorageScan({ config, dryRun: opts.dryRun });
    if (result.scanned) {
      process.stdout.write(
        JSON.stringify(
          {
            bucket: result.scanned.bucket,
            totalBytes: result.scanned.totalBytes,
            objectCount: result.scanned.objectCount,
            prefixCount: result.scanned.prefixes.length,
            reported: result.reported,
            errors: result.errors,
          },
          null,
          2,
        ) + '\n',
      );
    }
    if (!result.scanned) process.exit(1);
    if (!opts.dryRun && !result.reported) process.exit(2);
    process.exit(0);
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

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    log.error('mehen aborted', { error: (err as Error).message });
    process.exit(1);
  });
}
