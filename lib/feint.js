export default function feint(fn) {
	let called = false;

	return function feint(...args) {
		if (called) {
			return fn.call(this, ...args);
		}

		called = true;
	};
}
