import { rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import once from 'once';
import which from 'which';
import spawnStack from './spawn-stack.js';
import buildPurescript from './build-purescript.js';
import downloadPurescript from './download-purescript.js';
import { defaultBinName } from './config.js';
import verifyBinary from './verify-binary.js';

const HASHES = new Map([
	['darwin', 'macos'],
	['freebsd', 'freebsd'],
	['linux', 'linux'],
	['win32', 'windows']
]);

export default function downloadOrBuildPurescript({
	args, binName, binPath, headers, revision, version, progress, signal
}) {
	const cwd = process.cwd();
	const buildBinPath = join(cwd, defaultBinName);

	const stackPromise = which('stack')
		.then(async path => {
			const version = await spawnStack({ path, args: ['--numeric-version'], signal: AbortSignal.timeout(8000) });

			return [path, version];
		})
		.catch(e => {
			if (e.code === 'ENOENT') {
				const hash = HASHES.get(process.platform);

				e.INSTALL_URL = `https://docs.haskellstack.org/en/stable/install_and_upgrade/${
					hash ? `#${hash}` : ''
				}`;

				e.message = `\`stack\` command is not found in your PATH. Make sure you have installed Stack. ${
					e.INSTALL_URL
				}`;
			}

			throw e;
		});

	// avoid unhandled promise rejection error
	stackPromise.catch(() => {});

	async function startBuild() {
		if (signal?.aborted) {
			return;
		}

		const [path, version] = await stackPromise.catch(e => {
			e.id = 'check-stack';

			throw e;
		});

		progress({
			id: 'check-stack',
			path,
			version
		});
		progress({ id: 'check-stack:complete' });

		await buildPurescript({
			path,
			args,
			revision,
			headers,
			signal,
			progress(entry) {
				entry.id = entry.id.replace('download', 'download-source');
				progress(entry);
			}
		}).catch(e => {
			if (e.id) {
				e.id = e.id.replace('download', 'download-source');
			}

			throw e;
		});

		await rename(buildBinPath, binPath).catch(e => {
			e.id = 'build';

			throw e;
		});

		progress({ id: 'build:complete' });
	}

	let headComplete = false;

	const completeHead = once(() => {
		progress({ id: 'head:complete' });
		headComplete = true;
	});

	// Formerly, there was an unnecessary ensure-not-directory check here
	progress({ id: 'head' });

	return downloadPurescript({
		headers,
		version,
		signal,
		filter(path, entry) {
			if (basename(path, '.exe') !== 'purs') {
				return false;
			}

			completeHead();

			entry.path = `purescript/${binName}`;
			entry.header.path = `purescript/${binName}`;
			entry.absolute = join(cwd, binName);

			return true;
		},
		progress(entry) {
			entry.id = 'download-binary';
			progress(entry);
		}
	})
		.then(
			async () => {
				progress({ id: 'download-binary:complete' });
				progress({ id: 'check-binary' });

				try {
					await verifyBinary(binPath);
				} catch (err) {
					err.id = 'check-binary';

					progress({
						id: 'check-binary:fail',
						error: err
					});

					return startBuild();
				}

				progress({ id: 'check-binary:complete' });
			},
			e => {
				if (headComplete) {
					e.id = 'download-binary';

					progress({
						id: 'download-binary:fail',
						error: e
					});

					return startBuild();
				}

				if (e.code === 'ERR_UNSUPPORTED_ARCH' || e.code === 'ERR_UNSUPPORTED_PLATFORM') {
					e.id = 'head';

					progress({
						id: 'head:fail',
						error: e
					});

					return startBuild();
				}

				e.id = 'head';

				throw e;
			}
		);
}
