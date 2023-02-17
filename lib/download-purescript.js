import { basename } from 'path';
import { inspect } from 'util';
import semver from 'semver';
import isPlainObj from 'is-plain-obj';
import Observable from 'zen-observable';
import dlTar from './dl-tar.js';
import {
	arch, defaultVersion, supportedPlatforms, unsupportedPlatforms
} from './config.js';

const VERSION_ERROR = `Expected \`version\` option to be a string of PureScript version, for example '${defaultVersion}'`;

const defaultOptions = {
	filter: function isPurs(filePath) {
		return basename(filePath, '.exe') === 'purs';
	},
	baseUrl: 'https://github.com/purescript/purescript/releases/download/'
};

function createUnsupportedPlatformError() {
	const error = new Error(`Prebuilt \`purs\` binary is not provided for ${
		unsupportedPlatforms.get(process.platform)
	}.`);

	error.code = 'ERR_UNSUPPORTED_PLATFORM';
	Error.captureStackTrace(error, createUnsupportedPlatformError);

	return new Observable(observer => observer.error(error));
}

export default arch === 'x64' ? function downloadPurescript(...args) {
	const argLen = args.length;

	if (argLen === 0) {
		const archiveName = supportedPlatforms.get(process.platform);

		if (!archiveName) {
			return createUnsupportedPlatformError();
		}

		return dlTar(`v${defaultVersion}/${archiveName}.tar.gz`, process.cwd(), defaultOptions);
	} if (argLen !== 1) {
		const error = new RangeError(`Expected 0 or 1 argument ([<Object>]), but got ${argLen} arguments.`);
		error.code = 'ERR_TOO_MANY_ARGS';

		return new Observable(observer => observer.error(error));
	}

	const [options] = args;

	if (!isPlainObj(options)) {
		return new Observable(observer => {
			observer.error(new TypeError(`Expected download-purescript option to be an object, but got ${inspect(options)}.`));
		});
	}

	if (options.followRedirect !== undefined && !options.followRedirect) {
		return new Observable(observer => observer.error(new Error('`followRedirect` option cannot be disabled.')));
	}

	const { version } = options;

	if (version !== defaultVersion && version !== undefined) {
		if (typeof version !== 'string') {
			return new Observable(observer => {
				observer.error(new TypeError(`${VERSION_ERROR}, but got a non-string value ${inspect(version)}.`));
			});
		}

		if (version.length === 0) {
			return new Observable(observer => {
				observer.error(new Error(`${
					VERSION_ERROR
				}, but got '' (empty string). If you want to download the default version ${
					defaultVersion
				}, you don't need to pass any values to \`version\` option.`));
			});
		}

		if (!semver.valid(version)) {
			return new Observable(observer => {
				observer.error(new Error(`${VERSION_ERROR}, but got an invalid version ${inspect(version)}.`));
			});
		}
	}

	if (!supportedPlatforms.has(process.platform)) {
		return createUnsupportedPlatformError();
	}

	if (options.strip !== undefined && options.strip !== 1) {
		return new Observable(observer => {
			observer.error(new Error(`\`strip\` option is unchangeable, but ${
				inspect(options.strip)
			} was provided.`));
		});
	}

	const url = `v${version || defaultVersion}/${supportedPlatforms.get(process.platform)}.tar.gz`;

	return dlTar(url, process.cwd(), { ...defaultOptions, ...options });
} : function downloadPurescript() {
	if (!supportedPlatforms.has(process.platform)) {
		return createUnsupportedPlatformError();
	}

	return new Observable(() => {
		const error = new Error('The prebuilt PureScript binaries only support 64-bit architectures, but the current system is not 64-bit.');

		error.code = 'ERR_UNSUPPORTED_ARCH';
		error.currentArch = arch;

		throw error;
	});
};
