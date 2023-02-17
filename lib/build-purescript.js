import { mkdtemp, stat } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import {
	basename, dirname, join, resolve
} from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';
import isPlainObj from 'is-plain-obj';
import Observable from 'zen-observable';
import once from 'once';
import rimraf from 'rimraf';
import feint from './feint.js';
import spawnStack from './spawn-stack.js';
import downloadPurescriptSource from './download-purescript-source.js';
import { defaultBinName, supportedBuildFlags } from './config.js';

const directoryName = dirname(fileURLToPath(import.meta.url));

const ARGS_ERROR = 'Expected `args` option to be an array of user defined arguments passed to `stack setup` and `stack install`';

const negligibleLineRe = /^WARNING: (?:filepath wildcard|(?:File|Directory) listed|Installation path|Specified pattern) .*/ui;

function isLocalBinPathFlag(flag) {
	return flag.startsWith('--local-bin-path');
}

export default function buildPurescript(...args) {
	return new Observable(observer => {
		const argLen = args.length;

		if (argLen > 1) {
			const error = new RangeError(`Expected 0 or 1 argument ([<Object>]), but got ${argLen} arguments.`);
			error.code = 'ERR_TOO_MANY_ARGS';

			throw error;
		}

		const [options = {}] = args;

		if (argLen === 1) {
			if (!isPlainObj(options)) {
				throw new TypeError(`Expected build-purescript option to be an object, but got ${
					util.inspect(options)
				}.`);
			}

			// to validate download-purescript-source arguments beforehand
			const tmpSumscription = downloadPurescriptSource(directoryName, options).subscribe({
				error(err) {
					observer.error(err);
				}
			});
			setImmediate(() => tmpSumscription.unsubscribe());

			if (options.cwd !== undefined) {
				throw new Error(`build-purescript doesn't support \`cwd\` option, but ${
					util.inspect(options.cwd)
				} was provided.`);
			}

			if (options.args !== undefined) {
				if (!Array.isArray(options.args)) {
					throw new TypeError(`${ARGS_ERROR}, but got a non-array value ${
						util.inspect(options.args)
					}.`);
				}
			}
		}

		const subscriptions = new Set();
		const installArgs = [
			'install',
			`--local-bin-path=${process.cwd()}`,
			'--flag=purescript:RELEASE'
		];
		const defaultArgs = options.args ? options.args.filter(arg => {
			if (supportedBuildFlags.has(arg)) {
				installArgs.push(arg);

				return false;
			}

			return true;
		}) : [];

		if (defaultArgs.some(isLocalBinPathFlag)) {
			const error = new Error('`--local-bin-path` flag of the `stack` command is not configurable, but provided for `args` option.');
			error.code = 'ERR_INVALID_OPT_VALUE';

			throw error;
		}

		const spawnOptions = { cwd: null, ...options };
		const cleanupSourceDir = (cb = () => {}) => spawnOptions.cwd
			? rimraf(spawnOptions.cwd, { glob: false }, cb)
			: cb();

		const sendError = once((err, id) => {
			if (id) {
				Object.defineProperty(err, 'id', {
					value: id,
					configurable: true,
					writable: true
				});
			}

			cleanupSourceDir(() => observer.error(err));
		});

		const setupArgs = [...defaultArgs, 'setup'];
		const setupCommand = `stack ${setupArgs.join(' ')}`;
		const buildArgs = [...defaultArgs, ...installArgs];
		const buildCommand = `stack ${buildArgs.join(' ')}`;

		const startBuildOnReady = feint(() => {
			subscriptions.add(Observable.from(spawnStack(buildArgs, spawnOptions)).subscribe({
				next(line) {
					if (negligibleLineRe.test(line)) {
						return;
					}

					observer.next({
						id: 'build',
						command: buildCommand,
						output: line
					});
				},
				error(err) {
					const negligibleMultiLineRe = new RegExp(`${negligibleLineRe.source}\\n\\r?`, 'ugim');

					err.message = err.message.replace(negligibleMultiLineRe, '');
					err.stack = err.stack.replace(negligibleMultiLineRe, '');

					sendError(err, 'build');
				},
				complete() {
					cleanupSourceDir(() => {
						observer.next({ id: 'build:complete' });
						observer.complete();
					});
				}
			}));
		});

		const setup = once(() => {
			subscriptions.add(Observable.from(spawnStack(setupArgs, spawnOptions))
				.subscribe({
					next(line) {
						observer.next({
							id: 'setup',
							command: setupCommand,
							output: line
						});
					},
					error(err) {
						sendError(err, 'setup');
					},
					complete() {
						observer.next({ id: 'setup:complete' });
						startBuildOnReady();
					}
				}));
		});

		const binPath = resolve(defaultBinName);

		stat(resolve(defaultBinName), (err, stats) => {
			if (observer.closed || err || !stats.isDirectory()) {
				return;
			}

			const error = new Error(`Tried to create a PureScript binary at ${binPath}, but a directory already exists there.`);

			error.code = 'EISDIR';
			sendError(error);
		});

		mkdtemp(join(osTmpdir(), 'node-purescript-'), (err, tmpDir) => {
			if (err) {
				sendError(err);

				return;
			}

			spawnOptions.cwd = tmpDir;

			if (observer.closed) {
				cleanupSourceDir();

				return;
			}

			const download = downloadPurescriptSource(tmpDir, options)
				.subscribe({
					next(progress) {
						progress.id = 'download';
						observer.next(progress);

						const { remain, header: { path } } = progress.entry;

						if (remain === 0 && basename(path) === 'stack.yaml') {
							setup();
						}
					},
					error(downloadErr) {
						sendError(downloadErr, 'download');
					},
					complete() {
						setup();
						observer.next({ id: 'download:complete' });
						startBuildOnReady();
					}
				});

			subscriptions.add(download);
		});

		return function cancelBuild() {
			for (const subscription of subscriptions) {
				subscription.unsubscribe();
			}
		};
	});
}
