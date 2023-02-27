import execa from 'execa';
try {
	const r = await execa('yes', ['asd', 'asd'], { timeout: 20 });
} catch (e) {
	e.stdout = e.stdout.slice(0, 100)
	e.stderr = e.stderr.slice(0, 100)
	e.message = e.message.slice(0, 100)
	e.all = e.all.slice(0, 100)
console.log(e)
}

// console.log(Object.keys(r));
