import { execFile } from 'child_process';
import { promisify } from 'util';

export default function verifyBinary(binPath) {
	return promisify(execFile)(binPath, ['--version'], { timeout: 8000 });
}
