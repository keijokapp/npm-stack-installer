import { mkdtemp } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import {
	extname, sep, basename, join
} from 'node:path';
import once from 'once';
import rimraf from 'rimraf';
import spawnStack from './spawn-stack.js';
import dlTar from './dl-tar.js';
import { supportedBuildFlags } from './config.js';

const negligibleLineRe = /^WARNING: (?:filepath wildcard|(?:File|Directory) listed|Installation path|Specified pattern) .*/ui;

export default async function buildPurescript({
	progress, signal, args, revision, headers
}) {
	const installArgs = [
		'install',
		`--local-bin-path=${process.cwd()}`,
		'--flag=purescript:RELEASE'
	];

	const defaultArgs = args.filter(arg => {
		if (supportedBuildFlags.has(arg)) {
			installArgs.push(arg);

			return false;
		}

		return true;
	});

	if (defaultArgs.some(flag => flag.startsWith('--local-bin-path'))) {
		const e = new Error('`--local-bin-path` flag of the `stack` command is not configurable, but provided for `args` option.');
		e.code = 'ERR_INVALID_OPT_VALUE';

		throw e;
	}

	const setupArgs = [...defaultArgs, 'setup'];
	const setupCommand = `stack ${setupArgs.join(' ')}`;
	const buildArgs = [...defaultArgs, ...installArgs];
	const buildCommand = `stack ${buildArgs.join(' ')}`;

	const setup = once(() => spawnStack({
		args: setupArgs,
		signal,
		spawnOptions: { cwd },
		progress(line) {
			if (!signal?.aborted) {
				progress({
					id: 'setup',
					command: setupCommand,
					output: line
				});
			}
		}
	}));

	const cwd = await mkdtemp(join(osTmpdir(), 'node-purescript-'));

	try {
		signal?.throwIfAborted();

		await dlTar({
			baseUrl: 'https://github.com/purescript/purescript/archive/',
			destination: cwd,
			url: `${revision}.tar.gz`,
			headers,
			signal,
			progress(entry) {
				if (!signal?.aborted) {
					entry.id = 'download';
					progress(entry);

					const { remain, header: { path } } = entry.entry;

					if (remain === 0 && basename(path) === 'stack.yaml') {
						// start early; ignore errors as they will be handled later
						setup().catch(() => { /* ignored intentionally */ });
					}
				}
			},
			filter(_, { header: { path } }) {
				if (['.md', '.yml'].includes(extname(path))) {
					return false;
				}

				const [topLevelDir] = path.split(sep);

				for (const ignoredDir of ['appveyor', 'psc-ide', 'travis']) {
					if (path.startsWith(join(topLevelDir, ignoredDir))) {
						return false;
					}
				}

				return !['.gitignore', 'logo.png', 'make_release_notes'].includes(basename(path));
			}
		})
			.catch(e => { e.id = 'download'; throw e; });

		signal?.throwIfAborted();
		progress({ id: 'download:complete' });

		await setup().catch(e => { e.id = 'setup'; throw e; });

		signal?.throwIfAborted();
		progress({ id: 'setup:complete' });

		await spawnStack({
			args: buildArgs,
			signal,
			progress(line) {
				if (!signal?.aborted && !negligibleLineRe.test(line)) {
					progress({
						id: 'build',
						command: buildCommand,
						output: line
					});
				}
			},
			spawnOptions: { cwd }
		}).catch(e => {
			const negligibleMultiLineRe = new RegExp(`${negligibleLineRe.source}\\n\\r?`, 'ugim');

			e.message = e.message.replace(negligibleMultiLineRe, '');
			e.stack = e.stack.replace(negligibleMultiLineRe, '');
			e.id = 'build';

			throw e;
		});

		signal?.throwIfAborted();
	} finally {
		rimraf(cwd, { glob: false }, () => {});
	}
}
