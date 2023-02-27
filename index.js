#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import module from 'node:module';
import chalk from 'chalk';
import filesize from 'filesize';
import cacache from 'cacache';
import logUpdate from 'log-update';
import logSymbols from 'log-symbols';
import minimist from 'minimist';
import ms from 'ms';
import once from 'once';
import installPurescript from './lib/install-purescript.js';
import {
	cacheKey, defaultBinName, defaultCacheRootDir, defaultVersion, supportedBuildFlags
} from './lib/config.js';

const isPrettyMode = process.stdout && process.stdout.isTTY && !/^1|true$/ui.test(process.env.CI) && !process.env.GITHUB_ACTION;
chalk.enabled = chalk.enabled && isPrettyMode;

const {
	blue, cyan, dim, magenta, red, strikethrough, underline, yellow
} = chalk;

const failure = `${logSymbols.error} `;
const info = isPrettyMode ? `${logSymbols.info} ` : '';
const success = `${logSymbols.success} `;
const warning = `${logSymbols.warning} `;
const stackArgs = [];
const filesizeOptions = {
	base: 10,
	round: 2,
	standard: 'iec'
};
const argv = minimist(process.argv.slice(2), {
	boolean: [
		'help',
		'version'
	],
	string: [
		'name',
		'purs-ver'
	],
	default: {
		'purs-ver': '0.13.0'
	},
	unknown(flag) {
		if (!supportedBuildFlags.has(flag)) {
			return;
		}

		stackArgs.push(flag);
	}
});

const getPackageJson = once(() => {
	const require = module.createRequire(import.meta.url);

	return require('./package.json');
});

if (argv.help) {
	console.log(`install-purescript v${getPackageJson().version}
Install PureScript to the current working directory

Usage:
install-purescript [options]

Options:
--purs-ver <string> Specify PureScript version
                        Default: ${defaultVersion}
--name     <string> Change a binary name
                        Default: 'purs.exe' on Windows, 'purs' on others
                        Or, if the current working directory contains package.json
                        with \`bin\` field specifying a path of \`purs\` command,
                        this option defaults to its value
--help,             Print usage information
--version           Print version

Also, these flags are passed to \`stack install\` command if provided:
${[...supportedBuildFlags].join('\n')}
`);

	process.exit();
}

if (argv.version) {
	console.log(getPackageJson().version);
	process.exit();
}

if (!argv.name) {
	try {
		const require = module.createRequire(import.meta.url);
		// eslint-disable-next-line import/no-dynamic-require
		const { purs } = require(resolve('package.json')).bin;

		argv.name = purs !== undefined ? purs : defaultBinName;
	} catch (_) {
		argv.name = defaultBinName;
	}
}

class TaskGroup extends Map {
	constructor(iterable) {
		super(iterable);

		const pairs = [...this.entries()];

		for (const [index, [, task]] of pairs.entries()) {
			if (index < pairs.length - 1) {
				// eslint-disable-next-line prefer-destructuring
				task.nextTask = pairs[index + 1][1];
			}
		}
	}
}

const taskGroups = [
	new TaskGroup([
		[
			'search-cache',
			{
				head: ''
			}
		]
	]),
	new TaskGroup([
		[
			'restore-cache',
			{
				head: `Restore the cached ${cyan(argv['purs-ver'])} binary for ${process.platform}`
			}
		],
		[
			'check-binary',
			{
				head: 'Verify the restored binary works correctly'
			}
		]
	]),
	new TaskGroup([
		[
			'head',
			{
				head: `Check if a prebuilt ${cyan(argv['purs-ver'])} binary is provided for ${process.platform}`,
				status: 'processing'
			}
		],
		[
			'download-binary',
			{
				head: 'Download the prebuilt PureScript binary'
			}
		],
		[
			'check-binary',
			{
				head: 'Verify the prebuilt binary works correctly'
			}
		],
		[
			'write-cache',
			{
				head: 'Save the downloaded binary to the npm cache directory',
				allowFailure: true
			}
		]
	]),
	new TaskGroup([
		[
			'head',
			{
				head: '',
				status: 'processing'
			}
		],
		[
			'check-stack',
			{
				head: 'Check if \'stack\' command is available',
				status: 'processing',
				noClear: true
			}
		],
		[
			'download-source',
			{
				head: `Download the PureScript ${cyan(argv['purs-ver'])} source`,
				status: 'processing'
			}
		],
		[
			'setup',
			{
				head: 'Ensure the appropriate GHC is installed'
			}
		],
		[
			'build',
			{
				head: 'Build a binary from source'
			}
		],
		[
			'write-cache',
			{
				head: 'Save the built binary to the npm cache directory',
				allowFailure: true
			}
		]
	])
];

const path = resolve(argv.name);
const spinnerFrames = [4, 18, 50, 49, 53, 45, 31, 32, 0, 8].map(
	code => String.fromCharCode(10247 + code)
);
let time = Date.now();
let frame = 0;
let loop = 0;
let cacheWritten = false;
const render = isPrettyMode ? () => {
	const lines = [];

	for (const [taskName, {
		allowFailure, duration, head, message, status, subhead
	}] of taskGroups[0]) {
		let willEnd = false;

		if (status === 'done' || status === 'failed') {
			const timeInfo = ` (${ms(duration)})`;
			let mark;

			if (status === 'done') {
				mark = success;
			} else if (allowFailure) {
				mark = warning;
			} else {
				mark = failure;
			}

			if (process.stdout.columns > head.length + timeInfo.length + 2 && duration >= 100) {
				lines.push(ttyTruncate(`${mark}${head}${dim.gray(timeInfo)}`));
			} else {
				lines.push(ttyTruncate(`${mark}${head}`));
			}

			willEnd = true;
		} else if (status === 'processing') {
			lines.push(ttyTruncate(`${yellow(spinnerFrames[Math.floor(frame)])} ${head}`));
		} else if (status === 'skipped') {
			lines.push(ttyTruncate(`${yellow('▬')} ${strikethrough(head)}`));
			willEnd = true;
		} else {
			lines.push(ttyTruncate(`  ${head}`));
		}

		if (subhead) {
			lines.push(ttyTruncate(dim(`  ${subhead}`)));
		}

		if (message) {
			if (status === 'failed') {
				lines.push(`${red(`  ${message.replace(/^[ \t]+/u, '')}`)}`);
			} else {
				lines.push(ttyTruncate(dim(`\t${message}`)));
			}
		}

		if (willEnd && taskGroups[0].size > 1) {
			taskGroups[0].delete(taskName);
			logUpdate(`${lines.join('\n')}`);
			logUpdate.done();
			lines.splice(0);
		}
	}

	logUpdate(`${lines.join('\n')}\n`);
} : () => {
	for (const [taskName, {
		allowFailure, duration, message, status, head
	}] of taskGroups[0]) {
		if (status !== 'done' && status !== 'failed') {
			continue;
		}

		const durationStr = duration < 100 ? '' : ` (${ms(duration)})`;

		if (status === 'done') {
			console.log(`[ SUCCESS ] ${head}${durationStr}`);
		} else {
			console.log(`[ ${allowFailure ? 'WARNING' : 'FAILURE'} ] ${head}${durationStr}`);
			console.log(`${message}\n`);
		}

		taskGroups[0].delete(taskName);
	}
};

const initialize = once(firstEvent => {
	if (firstEvent.id === 'search-cache' && firstEvent.found) {
		console.log(`${info}Found a cache at ${magenta(dirname(firstEvent.path))}\n`);
	}

	if (!isPrettyMode) {
		return;
	}

	loop = setInterval(() => {
		frame += 0.5;

		if (frame === spinnerFrames.length) {
			frame = 0;
		}

		render();
	}, 40);
});

function calcDuration(task) {
	const newTime = Date.now();

	task.duration = newTime - time;
	time = newTime;
}

function getCurrentTask(currentId) {
	while (!taskGroups[0].has(currentId)) {
		taskGroups.shift();
	}

	return taskGroups[0].get(currentId);
}

function showError(erroredTask, err) {
	erroredTask.status = 'failed';

	if (!erroredTask.subhead && err.command) {
		erroredTask.subhead = err.command;
	}

	if (err.code === 'ERR_UNSUPPORTED_PLATFORM' || err.code === 'ERR_UNSUPPORTED_ARCH') {
		const environment = err.code === 'ERR_UNSUPPORTED_PLATFORM' ? process.platform : `${err.currentArch} architecture`;
		erroredTask.message = `No prebuilt PureScript binary is provided for ${environment}.`;
	} else if (err.INSTALL_URL) {
		erroredTask.message = `${'\'stack\' command is required for building PureScript from source, '
      + 'but it\'s not found in your PATH. Make sure you have installed Stack and try again.\n\n'
      + '→ '}${underline(err.INSTALL_URL)}`;
	} else {
		erroredTask.message = err.stack;
	}

	erroredTask.message += '\n\nSee troubleshooting suggestions in https://github.com/purescript/purescript/blob/master/INSTALL.md';

	calcDuration(erroredTask);

	for (const task of taskGroups[0].values()) {
		if (task.status !== 'done' && task.status !== 'failed') {
			task.status = 'skipped';
		}
	}
}

function downloadSummary({ max, bytes }) {
	return `${String(Math.round(100 * bytes / max))}% of ${filesize(max, filesizeOptions)}`;
}

function ttyTruncate(msg) {
	let maxWidth = 80;
	if (process.stdout && process.stdout.columns) {
		maxWidth = process.stdout.columns;
	}

	if (msg.length <= maxWidth) {
		return msg;
	}

	return `${msg.slice(0, 80)}…`;
}

installPurescript({
	args: stackArgs,
	headers: {
		'user-agent': 'purescript-installer (https://github.com/purescript/npm-installer)'
	},
	progress(event) {
		initialize(event);

		const task = getCurrentTask(event.id.replace(/:.*$/u, ''));

		if (event.id.endsWith(':fail')) {
			showError(task, event.error);
			render();

			if (task.allowFailure) {
				return;
			}

			if (isPrettyMode) {
				logUpdate.done();
			}

			taskGroups.shift();
			console.log(`${blue('↓')} ${taskGroups.length === 2 ? 'Reinstall a binary since the cache is broken' : 'Fallback: building from source'}\n`);

			return;
		}

		if (event.id.endsWith(':complete')) {
			task.status = 'done';
			calcDuration(task);

			if (!task.noClear) {
				task.subhead = '';
				task.message = '';
			}

			if (task.nextTask && !task.nextTask.status) {
				task.nextTask.status = 'processing';
			}

			if (event.id === 'write-cache:complete') {
				cacheWritten = true;
			}

			render();

			return;
		}

		if (!isPrettyMode) {
			if (event.output !== undefined) {
				if (!task.subhead) {
					task.subhead = event.command;
					console.log(`[ RUNNING ] command: ${task.subhead}`);
				}

				console.log(`  ${event.output}`);
			}

			return;
		}

		if (event.output !== undefined) {
			task.status = 'processing';
			task.subhead = event.command;
			task.message = event.output;

			return;
		}

		if (event.id === 'download-binary') {
			task.subhead = event.response.url;
			task.status = 'processing';

			task.message = downloadSummary({
				max: event.entry.size,
				bytes: event.entry.size - event.entry.remain
			});

			return;
		}

		if (event.id === 'download-source') {
			task.subhead = event.response.url;
			task.status = 'processing';

			task.message = downloadSummary({
				max: event.entry.size,
				bytes: event.entry.size - event.entry.remain
			});

			return;
		}

		if (event.id === 'check-stack') {
			task.message = `${event.version} found at ${event.path}`;
		}
	},
	rename: () => argv.name,
	version: argv['purs-ver']
}).then(
	async () => {
		render();
		clearInterval(loop);

		if (isPrettyMode) {
			logUpdate.done();
		} else {
			console.log();
		}

		const [{ size: bytes }, { path: cachePath, size: cacheBytes }] = await Promise.all([
			stat(path),
			cacheWritten
				? cacache.get.info(defaultCacheRootDir, cacheKey)
				: {}
		]);

		console.log(`Installed to ${magenta(path)} ${dim(filesize(bytes, filesizeOptions))}`);

		if (cachePath) {
			console.log(`Cached to ${magenta(dirname(cachePath))} ${dim(filesize(cacheBytes, filesizeOptions))}`);
		}

		console.log();
	},
	err => {
		clearInterval(loop);

		if (err.id) {
			const task = getCurrentTask(err.id);
			showError(task, err);
			render();
		} else {
			console.error(err.stack);
		}

		process.exitCode = 1;
	}
);
