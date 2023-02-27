import { spawn } from 'node:child_process';
import byline from 'byline';

export default async function spawnStack({
	args = [], cwd, path = 'stack', progress, signal
}) {
	if (
		process.platform !== 'win32'
		&& !args.includes('--allow-different-user')
		&& !args.includes('--no-allow-different-user')
	) {
		args = ['--allow-different-user', ...args];
	}

	signal?.throwIfAborted();

	const cp = spawn(path, args, { cwd });

	signal?.addEventListener('abort', () => { cp.kill(); });

	if (progress) {
		cp.stderr.setEncoding('utf8');

		byline(cp.stderr).on('data', line => {
			if (!signal?.aborted) {
				try {
					progress(line);
				} catch (e) {
					// ignored inteionally
				}
			}
		});
	}

	const chunks = [];
	cp.stdout.on('data', chunk => { chunks.push(chunk); });

	await new Promise((resolve, reject) => {
		if (signal != null) {
			signal?.addEventListener('abort', e => {
				cp.kill();

				reject(e);
			});
		}

		cp.on('error', reject);
		cp.on('close', (code, signal) => {
			if (code === 0) {
				resolve();
			} else {
				let e;

				if (code == null) {
					e = new Error(`Killed by signal: ${signal}`);
				} else {
					e = new Error(`Unexpected exit code: ${code}`);
				}

				e.command = [path, ...args].join(' ');
				reject(e);
			}
		});
	});

	signal?.throwIfAborted();

	return Buffer.concat(chunks).toString();
}
