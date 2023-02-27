import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import util from 'node:util';
import tap from 'tap';
import rimraf from 'rimraf';
import installPurescript from '../lib/install-purescript.js';

const cacheRootDir = '.test-cache';

// Set a timeout of 60s (default is 30s)
tap.setTimeout(1000 * 60);

rimraf.sync(cacheRootDir);

function assertEvents(t, _found, _expected) {
	const found = _found.slice();
	const expected = _expected.slice();

	while (found.length > 0 && expected.length > 0) {
		const next = found.shift();
		// eslint-disable-next-line eqeqeq
		if (next.id == expected[0].id) {
			const nextExpected = expected.shift();
			t.match(next, nextExpected, `received ${next.id} event`);
		}
	}

	if (expected.length > 0) {
		t.fail(`expected the following events, but did not receive them: ${expected.map(x => x.id).join(', ')}`);
	} else {
		t.ok(true, 'received all expected events');
	}
}

// return a promise which resolves once the given file has been unlinked,
// swallowing ENOENT errors (which indicate the file never existed in the first
// place).
async function unlinkIfExists(path) {
	try {
		await unlink(path);
	} catch (err) {
		if (err.code !== 'ENOENT') {
			throw err;
		}
	}
}

function testInstall(version, expectedEvents) {
	return (async t => {
		await unlinkIfExists('./purs');
		let lastEventId;
		const events = [];
		await installPurescript({
			cacheRootDir,
			progress(event) {
				if (event.id !== lastEventId) {
					events.push(event);
				}
				lastEventId = event.id;
			},
			version
		});
		assertEvents(t, events, expectedEvents);
		const { stdout } = await util.promisify(execFile)('./purs', ['--version'], { timeout: 1000 });
		t.match(stdout.toString(), version);
	});
}

tap.test('clean install', testInstall('0.15.7', [
	{ id: 'search-cache', found: false },
	{ id: 'download-binary' },
	{ id: 'check-binary' },
	{ id: 'write-cache' }
]));

tap.test('install from cache', testInstall('0.15.7', [
	{ id: 'search-cache', found: true },
	{ id: 'restore-cache' },
	{ id: 'check-binary' }
]));

tap.test('install a different version', testInstall('0.15.6', [
	{ id: 'search-cache', found: false },
	{ id: 'download-binary' },
	{ id: 'check-binary' },
	{ id: 'write-cache' }
]));

tap.test('install a different version from cache', testInstall('0.15.6', [
	{ id: 'search-cache', found: true },
	{ id: 'restore-cache' },
	{ id: 'check-binary' }
]));
