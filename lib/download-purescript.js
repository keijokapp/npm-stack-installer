import dlTar from './dl-tar.js';
import { arch, supportedPlatforms, unsupportedPlatforms } from './config.js';

export default async function downloadPurescript({
	filter, headers, progress, signal, version
}) {
	if (!supportedPlatforms.has(process.platform)) {
		const error = new Error(`Prebuilt \`purs\` binary is not provided for ${
			unsupportedPlatforms.get(process.platform)
		}.`);

		error.code = 'ERR_UNSUPPORTED_PLATFORM';

		throw error;
	}

	if (arch !== 'x64') {
		const error = new Error('The prebuilt PureScript binaries only support 64-bit architectures, but the current system is not 64-bit.');

		error.code = 'ERR_UNSUPPORTED_ARCH';
		error.currentArch = arch;

		throw error;
	}

	return dlTar({
		baseUrl: 'https://github.com/purescript/purescript/releases/download/',
		destination: process.cwd(),
		filter,
		headers,
		progress,
		signal,
		url: `v${version}/${supportedPlatforms.get(process.platform)}.tar.gz`
	});
}
