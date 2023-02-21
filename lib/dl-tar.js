import { resolve } from 'path';
import { Transform, pipeline as pump } from 'stream';
import fs from 'fs/promises';
import { Unpack } from 'tar';
import fetch from 'make-fetch-happen';

export default async function dlTar({
	url, destination, baseUrl, headers, signal, progress, filter
}) {
	const cwd = process.cwd();
	const absoluteDest = resolve(cwd, destination);

	if (absoluteDest !== cwd) {
		signal?.throwIfAborted();
		await fs.mkdir(absoluteDest, { recursive: true });
	}

	signal?.throwIfAborted();

	const { href } = new URL(url, baseUrl);

	const response = await fetch(href, { headers }).then(response => {
		if (response.ok !== true) {
			throw new Error(`${response.status} ${response.statusText}`);
		}

		return response;
	});

	const finalUrl = response.url;
	const responseHeaders = response.headers;
	let responseBytes = 0;

	if (progress) {
		const originalProgress = progress;

		progress = entry => {
			signal?.throwIfAborted();

			originalProgress({
				entry,
				response: {
					url: finalUrl,
					headers: responseHeaders,
					bytes: responseBytes
				}
			});
		};
	}

	function emitProgress(entry) {
		try {
			progress(entry);
		} catch (e) {
			// ignored intentionally
		}
	}

	function emitFirstProgress(entry) {
		const originalRemain = entry.remain;
		const originalBlockRemain = entry.blockRemain;

		entry.remain = entry.size;
		entry.blockRemain = entry.startBlockSize;
		emitProgress(entry);
		entry.remain = originalRemain;
		entry.blockRemain = originalBlockRemain;
	}

	const unpackStream = new Unpack({
		cwd: absoluteDest,
		strict: true,
		strip: 1,
		filter,
		onentry(entry) {
			if (entry.size === 0) {
				setImmediate(() => emitProgress(entry));

				return;
			}

			if (entry.remain === 0) {
				setImmediate(() => {
					emitFirstProgress(entry);
					emitProgress(entry);
				});

				return;
			}

			const originalWrite = entry.write.bind(entry);
			let firstValueEmitted = false;

			entry.write = data => {
				const originalReturn = originalWrite(data);

				if (!firstValueEmitted) {
					firstValueEmitted = true;
					emitFirstProgress(entry);
				}

				emitProgress(entry);

				return originalReturn;
			};
		}
	});

	const pipe = [
		response.body,
		new Transform({
			transform(chunk, encoding, cb) {
				responseBytes += chunk.length;
				cb(null, chunk);
			}
		}),
		unpackStream
	];

	signal?.throwIfAborted();

	await new Promise((resolve, reject) => {
		pump(pipe, err => {
			if (err) {
				reject(err);

				return;
			}

			resolve();
		});

		if (signal?.aborted) {
			unpackStream.emit('error', signal.reason);
		} else {
			signal?.addEventListener('abort', e => {
				unpackStream.emit('error', e);
			});
		}
	});
}
