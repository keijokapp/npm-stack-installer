import envPaths from 'env-paths';
import getArch from 'arch';

export const defaultVersion = '0.12.5';

export const supportedPlatforms = new Map([
	['linux', 'linux64'],
	['darwin', 'macos'],
	['win32', 'win64']
]);

export const unsupportedPlatforms = new Map([
	['aix', 'AIX'],
	['android', 'Android'],
	['freebsd', 'FreeBSD'],
	['openbsd', 'OpenBSD'],
	['sunos', 'Solaris']
]);

export const defaultCacheRootDir = envPaths('purescript-npm-installer').cache;
export const cacheKey = 'install-purescript:binary';

export const supportedBuildFlags = new Set([
	'--dry-run',
	'--pedantic',
	'--fast',
	'--only-snapshot',
	'--only-dependencies',
	'--only-configure',
	'--trace',
	'--profile',
	'--no-strip',
	'--coverage',
	'--no-run-tests',
	'--no-run-benchmarks'
]);

export const arch = getArch();

export const defaultBinName = `purs${process.platform === 'win32' ? '.exe' : ''}`;
