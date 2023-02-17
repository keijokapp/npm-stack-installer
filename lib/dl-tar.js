import { inspect } from 'util';
import { resolve } from 'path';
import { Transform, pipeline as pump } from 'stream';
import fs from 'fs/promises';
import { Unpack } from 'tar';
import isPlainObj from 'is-plain-obj';
import fetch from 'make-fetch-happen';
import Observable from 'zen-observable';

const cancel = new Error('Canceled.');

function cancelablePump(...args) {
	if (args.length === 0) {
		throw new RangeError('Expected at least 1 argument, but got no arguments.');
	}

	const nonCallbackArgs = args;
	const callback = typeof nonCallbackArgs[nonCallbackArgs.length - 1] === 'function'
		? nonCallbackArgs.pop()
		: null;

	const streams = Array.isArray(args[0]) ? args[0] : nonCallbackArgs;
	const streamCount = streams.length;

	if (streamCount < 2) {
		throw new RangeError(`cancelable-pump requires more than 2 streams, but got ${streamCount}.`);
	}

	pump(streams, err => {
		if (!callback) {
			return;
		}

		if (err && err !== cancel) {
			callback(err);

			return;
		}

		callback();
	});

	return function cancelStreams() {
		streams[streamCount - 1].emit('error', cancel);
	};
}

class InternalUnpack extends Unpack {
	constructor(options) {
		super({
			strict: true,
			strip: 1,
			...options,
			onentry(entry) {
				if (entry.size === 0) {
					setImmediate(() => this.emitProgress(entry));

					return;
				}

				if (entry.remain === 0) {
					setImmediate(() => {
						this.emitFirstProgress(entry);
						this.emitProgress(entry);
					});

					return;
				}

				const originalWrite = entry.write.bind(entry);
				let firstValueEmitted = false;

				entry.write = data => {
					const originalReturn = originalWrite(data);

					if (!firstValueEmitted) {
						firstValueEmitted = true;
						this.emitFirstProgress(entry);
					}

					this.emitProgress(entry);

					return originalReturn;
				};
			}
		});

		this.observer = options.observer;
		this.url = '';
		this.responseHeaders = null;
		this.responseBytes = 0;
	}

	emitProgress(entry) {
		this.observer.next({
			entry,
			response: {
				url: this.url,
				headers: this.responseHeaders,
				bytes: this.responseBytes
			}
		});
	}

	emitFirstProgress(entry) {
		const originalRemain = entry.remain;
		const originalBlockRemain = entry.blockRemain;

		entry.remain = entry.size;
		entry.blockRemain = entry.startBlockSize;
		this.emitProgress(entry);
		entry.remain = originalRemain;
		entry.blockRemain = originalBlockRemain;
	}
}

const functionOptions = new Set(['filter', 'onwarn', 'transform']);

const DEST_ERROR = 'Expected a path where downloaded tar archive will be extracted';
const STRIP_ERROR = 'Expected `strip` option to be a non-negative integer (0, 1, ...) '
                    + 'that specifies how many leading components from file names will be stripped';

export default function dlTar(...args) {
	const argLen = args.length;

	if (argLen !== 2 && argLen !== 3) {
		throw new RangeError(`Expected 2 or 3 arguments (<string>, <string>[, <Object>]), but got ${
			argLen === 0 ? 'no' : argLen
		} arguments instead.`);
	}

	const [url, dest, options = {}] = args;

	return new Observable(observer => {
		if (typeof url !== 'string') {
			throw new TypeError(`Expected a URL of tar archive, but got ${inspect(url)}.`);
		}

		if (url.length === 0) {
			throw new Error('Expected a URL of tar archive, but got \'\' (empty string).');
		}

		if (typeof dest !== 'string') {
			throw new TypeError(`${DEST_ERROR}, but got ${inspect(dest)}.`);
		}

		if (dest.length === 0) {
			throw new Error(`${DEST_ERROR}, but got '' (empty string).`);
		}

		if (argLen === 3) {
			if (!isPlainObj(options)) {
				throw new TypeError(`Expected an object to specify \`dl-tar\` options, but got ${inspect(options)}.`);
			}

			if (options.method) {
				const formattedMethod = inspect(options.method);

				if (formattedMethod.toLowerCase() !== '\'get\'') {
					throw new (typeof options.method === 'string' ? Error : TypeError)(`Invalid \`method\` option: ${
						formattedMethod
					}. \`dl-tar\` module is designed to download archive files. So it only supports the default request method "GET" and it cannot be overridden by \`method\` option.`);
				}
			}

			for (const optionName of functionOptions) {
				const val = options[optionName];

				if (val !== undefined && typeof val !== 'function') {
					throw new TypeError(`\`${optionName}\` option must be a function, but got ${
						inspect(val)
					}.`);
				}
			}

			if (options.strip !== undefined) {
				if (typeof options.strip !== 'number') {
					throw new TypeError(`${STRIP_ERROR}, but got a non-number value ${inspect(options.strip)}.`);
				}

				if (!Number.isFinite(options.strip)) {
					throw new RangeError(`${STRIP_ERROR}, but got ${options.strip}.`);
				}

				if (options.strip > Number.MAX_SAFE_INTEGER) {
					throw new RangeError(`${STRIP_ERROR}, but got a too large number.`);
				}

				if (options.strip < 0) {
					throw new RangeError(`${STRIP_ERROR}, but got a negative number ${options.strip}.`);
				}

				if (!Number.isInteger(options.strip)) {
					throw new Error(`${STRIP_ERROR}, but got a non-integer number ${options.strip}.`);
				}
			}

			if (options.onentry !== undefined) {
				throw new Error('`dl-tar` does not support `onentry` option.');
			}
		}

		const cwd = process.cwd();
		const absoluteDest = resolve(cwd, dest);
		let ended = false;
		let cancel;

		(async () => {
			try {
				if (absoluteDest !== cwd) {
					await fs.mkdir(absoluteDest, { recursive: true });
				}

				if (ended) {
					return;
				}

				const unpackStream = new InternalUnpack({
					...options,
					cwd: absoluteDest,
					observer
				});

				const { baseUrl, headers } = options;
				const { href } = new URL(url, baseUrl);

				const res = await fetch(href, { headers }).then(response => {
					if (response.ok !== true) {
						throw new Error(`${response.status} ${response.statusText}`);
					}

					unpackStream.url = response.url;
					unpackStream.responseHeaders = response.headers;

					return response;
				});

				const pipe = [
					res.body,
					new Transform({
						transform(chunk, encoding, cb) {
							unpackStream.responseBytes += chunk.length;
							cb(null, chunk);
						}
					}),
					unpackStream
				];

				cancel = cancelablePump(pipe, err => {
					ended = true;

					if (err) {
						observer.error(err);

						return;
					}

					observer.complete();
				});
			} catch (err) {
				ended = true;
				observer.error(err);
			}
		})();

		return function cancelExtract() {
			if (!cancel) {
				ended = true;

				return;
			}

			if (ended) {
				return;
			}

			cancel();
		};
	});
}
