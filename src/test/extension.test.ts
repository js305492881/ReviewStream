import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { __test__ } from '../../src/extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('parseGitCleanFailurePaths extracts failed paths from warnings', () => {
		const result = __test__.parseGitCleanFailurePaths({
			ok: false,
			stdout: '',
			stderr: [
				'warning: failed to remove Library/ArtifactDB: Invalid argument',
				'warning: failed to remove Temp/UnityLockfile: Invalid argument',
				'warning: failed to remove Library/ArtifactDB: Invalid argument',
			].join('\n'),
			errorMessage: 'git clean failed',
		});

		assert.deepStrictEqual(result, ['Library/ArtifactDB', 'Temp/UnityLockfile']);
	});

	test('areAllPathsUnityGenerated returns true for Unity-generated caches only', () => {
		assert.strictEqual(
			__test__.areAllPathsUnityGenerated([
				'Library/ArtifactDB',
				'Logs/AssetImportWorker3.log',
				'Temp/UnityLockfile',
			]),
			true,
		);
		assert.strictEqual(
			__test__.areAllPathsUnityGenerated([
				'Library/ArtifactDB',
				'Assets/MyConfig.asset',
			]),
			false,
		);
	});
});
