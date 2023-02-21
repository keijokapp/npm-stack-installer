import {
	extname, basename, join, sep
} from 'path';
import dlTar from './dl-tar.js';

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

export default function downloadPurescriptSource({
	baseUrl,
	destination,
	headers,
	progress,
	revision,
	signal
}) {
	return dlTar({
		baseUrl: baseUrl ?? 'https://github.com/purescript/purescript/archive/',
		destination,
		headers,
		progress,
		signal,
		url: `${revision}.tar.gz`,
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
	});
}
