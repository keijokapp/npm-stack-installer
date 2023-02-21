import byline from 'byline';
import execa from 'execa';

const HASHES = new Map([
	['darwin', 'macos'],
	['freebsd', 'freebsd'],
	['linux', 'linux'],
	['win32', 'windows']
]);

export default async function spawnStack({
	args, signal, progress, spawnOptions
}) {
	if (
		process.platform !== 'win32'
		&& !args.includes('--allow-different-user')
		&& !args.includes('--no-allow-different-user')
	) {
		args = ['--allow-different-user', ...args];
	}

	signal?.throwIfAborted();

	const cp = execa('stack', args, { preferLocal: false, spawnOptions });

	signal?.addEventListener('abort', () => { cp.kill(); });

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

	try {
		const result = await cp;

		signal?.throwIfAborted();

		return result.stdout;
	} catch (e) {
		signal?.throwIfAborted();

		if (e.code === 'ENOENT') {
			const hash = HASHES.get(process.platform);

			e.INSTALL_URL = `https://docs.haskellstack.org/en/stable/install_and_upgrade/${
				hash ? `#${hash}` : ''
			}`;

			e.message = `\`stack\` command is not found in your PATH. Make sure you have installed Stack. ${
				e.INSTALL_URL
			}`;
		}

		if (!e.killed) {
			throw e;
		}
	}
}
