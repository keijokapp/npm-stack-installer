import { execFile } from 'node:child_process';
import { rename, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { inspect, promisify } from 'node:util';
import isPlainObj from 'is-plain-obj';
import Observable from 'zen-observable';
import once from 'once';
import which from 'which';
import spawnStack from './spawn-stack.js';
import feint from './feint.js';
import buildPurescript from './build-purescript.js';
import downloadPurescript from './download-purescript.js';
import { defaultBinName, defaultVersion } from './config.js';

function addId(obj, id) {
	Object.defineProperty(obj, 'id', {
		value: id,
		writable: true
	});
}

const unsupportedOptions = new Set(['filter', 'revision']);

export default function downloadOrBuildPurescript(...args) {
	return new Observable(observer => {
		const argLen = args.length;

		if (argLen > 1) {
			const error = new RangeError(`Expected 0 or 1 argument ([<Object>]), but got ${argLen} arguments.`);
			error.code = 'ERR_TOO_MANY_ARGS';

			throw error;
		}

		const [options = {}] = args;
		const subscriptions = new Set();
		const stackCheckResult = {
			id: 'check-stack',
			path: 'stack',
			version: ''
		};

		if (argLen === 1) {
			if (!isPlainObj(options)) {
				throw new TypeError(`Expected an object to specify options of install-purescript, but got ${
					inspect(options)
				}.`);
			}

			if (options.rename !== undefined && typeof options.rename !== 'function') {
				throw new TypeError(`\`rename\` option must be a function, but ${
					inspect(options.rename)
				} was provided.`);
			}

			for (const optionName of unsupportedOptions) {
				const val = options[optionName];

				if (val !== undefined) {
					throw new Error(`\`${optionName}\` option is not supported, but ${inspect(val)} was provided to it.`);
				}
			}
		}

		const version = options.version ?? defaultVersion;
		const buildOptions = { revision: `v${version}`, ...options };
		const binName = options.rename ? options.rename(defaultBinName) : defaultBinName;

		if (typeof binName !== 'string') {
			throw new TypeError(`Expected \`rename\` option to be a function that returns a string, but returned ${
				inspect(binName)
			}.`);
		}

		if (binName.length === 0) {
			throw new Error('Expected `rename` option to be a function that returns a new binary name, but returned \'\' (empty string).');
		}

		const cwd = process.cwd();
		const binPath = join(cwd, binName);

		// to validate build-purescript arguments beforehand
		const tmpSubscription = buildPurescript(buildOptions).subscribe({
			error(err) {
				observer.error(err);
			}
		});

		function sendError(err, id) {
			addId(err, id);
			observer.error(err);
		}

		const startBuild = feint(() => {
			if (stackCheckResult.error) {
				sendError(stackCheckResult.error, 'check-stack');

				return;
			}

			observer.next(stackCheckResult);
			observer.next({ id: 'check-stack:complete' });

			subscriptions.add(buildPurescript(buildOptions).subscribe({
				next(progress) {
					if (progress.id === 'build:complete') {
						// No need to check `join(cwd, initialBinName) !== binPath`, because:
						// > If oldpath and newpath are existing hard links referring to
						// > the same file, then rename() does nothing,
						// > and returns a success status.
						// (http://man7.org/linux/man-pages/man2/rename.2.html#DESCRIPTION)
						rename(join(cwd, defaultBinName), binPath).then(
							() => {
								observer.next(progress);
								observer.complete();
							},
							err => {
								sendError(err, 'build');
							}
						);

						return;
					}

					progress.id = progress.id.replace('download', 'download-source');
					observer.next(progress);
				},
				error(err) {
					sendError(err, err.id.replace('download', 'download-source'));
				}
			}));
		});

		const startBuildIfNeeded = () => {
			if (observer.closed) {
				return;
			}

			startBuild();
		};

		which('stack', async (_, stackPath) => {
			stackCheckResult.path = stackPath;

			try {
				stackCheckResult.version = (await spawnStack(['--numeric-version'], { timeout: 8000, ...options })).stdout;
			} catch (err) {
				stackCheckResult.error = err;
			}

			startBuildIfNeeded();
		});

		const downloadObserver = {
			next(progress) {
				progress.id = 'download-binary';
				observer.next(progress);
			},
			error(err) {
				if (err.code === 'ERR_UNSUPPORTED_ARCH' || err.code === 'ERR_UNSUPPORTED_PLATFORM') {
					addId(err, 'head');

					observer.next({
						id: 'head:fail',
						error: err
					});

					startBuildIfNeeded();

					return;
				}

				sendError(err, 'head');
			},
			async complete() {
				observer.next({ id: 'download-binary:complete' });
				observer.next({ id: 'check-binary' });

				try {
					await promisify(execFile)(binPath, ['--version'], { timeout: 8000, ...options });
				} catch (err) {
					addId(err, 'check-binary');

					observer.next({
						id: 'check-binary:fail',
						error: err
					});

					startBuildIfNeeded();

					return;
				}

				observer.next({ id: 'check-binary:complete' });
				observer.complete();
			}
		};

		const completeHead = feint(once(() => {
			observer.next({ id: 'head:complete' });
			downloadObserver.error = err => {
				addId(err, 'download-binary');

				observer.next({
					id: 'download-binary:fail',
					error: err
				});

				startBuildIfNeeded();
			};
		}));

		(async () => {
			const [stats] = await Promise.all([
				stat(binPath).catch(err => {
					if (err.code === 'ERR_INVALID_ARG_VALUE') {
						observer.error(err);
					}

					return null;
				}),
				promisify(setImmediate)().then(() => { tmpSubscription.unsubscribe(); })
			]);

			if (observer.closed) {
				return;
			}

			if (stats && stats.isDirectory()) {
				const error = new Error(`Tried to create a PureScript binary at ${binPath}, but a directory already exists there.`);

				error.code = 'EISDIR';
				observer.error(error);

				return;
			}

			observer.next({ id: 'head' });
			completeHead();
		})();

		subscriptions.add(new Observable(observer => {
			const abort = new AbortController();

			downloadPurescript({
				...options,
				signal: abort.signal,
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
				version,
				progress(entry) {
					observer.next(entry);
				}
			})
				.then(
					d => observer.complete(d),
					e => observer.error(e)
				);

			return () => { abort.abort(); };
		}).subscribe(downloadObserver));

		return function cancelBuildOrDownloadPurescript() {
			for (const subscription of subscriptions) {
				subscription.unsubscribe();
			}
		};
	});
}
