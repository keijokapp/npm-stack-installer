import { createReadStream, createWriteStream } from 'node:fs';
import {
	chmod, lstat, stat, unlink
} from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { inspect } from 'node:util';
import cacache from 'cacache';
import Observable from 'zen-observable';
import semver from 'semver';
import downloadOrBuildPurescript from './download-or-build-purescript.js';
import {
	arch, cacheKey, defaultBinName, defaultCacheRootDir, defaultVersion
} from './config.js';
import verifyBinary from './verify-binary.js';

export default function installPurescript({
	rename = () => defaultBinName,
	version = defaultVersion,
	cacheRootDir = defaultCacheRootDir,
	args = [],
	headers
}) {
	const binName = normalize(`${rename(defaultBinName)}`);
	const cwd = process.cwd();
	const binPath = join(cwd, binName);
	const cacheId = `${version}-${process.platform}-${arch}`;

	cacheRootDir ??= defaultCacheRootDir;

	const abort = new AbortController();
	const { signal } = abort;

	return new Observable(observer => {
		if (!semver.valid(version)) {
			throw new Error(`Expected \`version\` option to be a string of PureScript version, for example '${defaultVersion}', but got an invalid version ${inspect(version)}.`);
		}

		function progress(entry) {
			observer.next(entry);
		}

		async function main(brokenCacheFound = false) {
			const cacheCleaning = (async () => {
				if (brokenCacheFound) {
					await cacache.rm.entry(cacheRootDir, cacheKey)
						.catch(() => { /* ignored intentionally */ });
				}

				await cacache.verify(cacheRootDir)
					.catch(() => { /* ignored intentionally */ });
			})();

			try {
				await downloadOrBuildPurescript({
					args,
					binName,
					binPath,
					headers,
					progress,
					revision: `v${version}`,
					signal,
					version
				});
			} finally {
				await cacheCleaning;
			}

			progress({ id: 'write-cache' });

			try {
				const { size, mode } = await lstat(binPath);

				const cacheStream = cacache.put.stream(cacheRootDir, cacheKey, {
					size,
					metadata: {
						id: cacheId,
						mode
					}
				});

				await pipeline(
					createReadStream(binPath),
					cacheStream
				);
			} catch (e) {
				e.id = 'write-cache';

				progress({
					id: 'write-cache:fail',
					error: e
				});

				return;
			}

			progress({ id: 'write-cache:complete' });
		}

		(async () => {
			const searchCacheValue = {
				id: 'search-cache',
				found: false
			};

			const [info] = await Promise.all([
				cacache.get.info(cacheRootDir, cacheKey),
				stat(binPath)
					.then(stats => {
						if (stats.isDirectory()) {
							const error = new Error(`Tried to create a PureScript binary at ${binPath}, but a directory already exists there.`);

							error.code = 'EISDIR';
							error.path = binPath;

							throw error;
						} else {
							return unlink(binPath);
						}
					})
					.catch(e => {
						if (e.code !== 'ENOENT') {
							throw e;
						}
					})
			]);

			signal?.throwIfAborted();

			if (info == null) {
				progress(searchCacheValue);

				return main();
			}

			const { metadata: { id, mode: binMode }, path: cachePath } = info;

			if (id !== cacheId) {
				progress(searchCacheValue);

				return main(true);
			}

			progress({
				id: 'search-cache',
				found: true,
				path: cachePath
			});
			progress({ id: 'restore-cache' });

			try {
				await pipeline(
					createReadStream(cachePath),
					createWriteStream(binPath)
				);
				await chmod(binPath, binMode);
			} catch (e) {
				e.id = 'restore-cache';

				progress({
					id: 'restore-cache:fail',
					error: e
				});

				return main(true);
			}

			progress({ id: 'restore-cache:complete' });
			progress({ id: 'check-binary' });

			try {
				await verifyBinary(binPath);
			} catch (e) {
				e.id = 'check-binary';

				progress({
					id: 'check-binary:fail',
					error: e
				});

				return main(true);
			}

			progress({ id: 'check-binary:complete' });
		})()
			.then(
				() => { observer.complete(); },
				e => { observer.error(e); }
			);

		return () => { abort.abort(); };
	});
}
