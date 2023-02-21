import util from 'util';
import {
	extname, basename, join, sep
} from 'path';
import Observable from 'zen-observable';
import dlTar from './dl-tar.js';

export const defaultRevision = 'v0.12.5';
const REV_ERROR = `Expected \`revision\` option to be a string of PureScript version or commit hash, for exmaple '${defaultRevision}' and 'ee2fcf'`;

const ignoredExtensions = new Set([
	'.md',
	'.yml'
]);

const ignoredDirectoryNames = [
	'appveyor',
	'psc-ide',
	'travis'
];

const ignoredFilenames = new Set([
	'.gitignore',
	'logo.png',
	'make_release_notes'
]);

export default function downloadPurescriptSource(dir, options) {
	const rev = options.revision;

	if (rev !== undefined) {
		if (typeof rev !== 'string') {
			return new Observable(observer => {
				observer.error(new TypeError(`${REV_ERROR}, but got a non-string value ${util.inspect(rev)}.`));
			});
		}

		if (rev.length === 0) {
			return new Observable(observer => {
				observer.error(new Error(`${REV_ERROR}, but got '' (empty string).`));
			});
		}
	}

	if (options.strip !== undefined && options.strip !== 1) {
		return new Observable(observer => {
			observer.error(new Error(`\`strip\` option is unchangeable, but ${
				util.inspect(options.strip)
			} was provided.`));
		});
	}

	return new Observable(observer => {
		const abort = new AbortController();

		dlTar({
			baseUrl: options.baseUrl ?? 'https://github.com/purescript/purescript/archive/',
			destination: dir,
			headers: options.headers,
			progress(entry) {
				observer.next(entry);
			},
			signal: abort.signal,
			url: `${rev || defaultRevision}.tar.gz`,
			filter(_, { header: { path } }) {
				if (ignoredExtensions.has(extname(path))) {
					return false;
				}

				const [topLevelDir] = path.split(sep);

				for (const ignoredDir of ignoredDirectoryNames) {
					if (path.startsWith(join(topLevelDir, ignoredDir))) {
						return false;
					}
				}

				return !ignoredFilenames.has(basename(path));
			}
		})
			.then(
				a => observer.complete(a),
				e => observer.error(e)
			);

		return () => { abort.abort(); };
	});
}
