import * as assert from "assert";

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from "vscode";
import { __test__ } from "../../src/extension";

suite("Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  test("Sample test", () => {
    assert.strictEqual(-1, [1, 2, 3].indexOf(5));
    assert.strictEqual(-1, [1, 2, 3].indexOf(0));
  });

  test("parseGitCleanFailurePaths extracts failed paths from warnings", () => {
    const result = __test__.parseGitCleanFailurePaths({
      ok: false,
      stdout: "",
      stderr: [
        "warning: failed to remove Library/ArtifactDB: Invalid argument",
        "warning: failed to remove Temp/UnityLockfile: Invalid argument",
        "warning: failed to remove Library/ArtifactDB: Invalid argument",
      ].join("\n"),
      errorMessage: "git clean failed",
    });

    assert.deepStrictEqual(result, [
      "Library/ArtifactDB",
      "Temp/UnityLockfile",
    ]);
  });

  test("areAllPathsUnityGenerated returns true for Unity-generated caches only", () => {
    assert.strictEqual(
      __test__.areAllPathsFallbackCleanable(
        [
          "Library/ArtifactDB",
          "Logs/AssetImportWorker3.log",
          "Temp/UnityLockfile",
        ],
        ["library", "logs", "temp"],
      ),
      true,
    );
    assert.strictEqual(
      __test__.areAllPathsFallbackCleanable(
        ["Library/ArtifactDB", "Assets/MyConfig.asset"],
        ["library", "logs", "temp"],
      ),
      false,
    );
  });
});

suite("Push for Review 远端解析", () => {
  test("parseGitRemoteOutput 忽略空行与首尾空白", () => {
    assert.deepStrictEqual(
      __test__.parseGitRemoteOutput("\n origin \r\ngithub\n\n"),
      ["origin", "github"],
    );
    assert.deepStrictEqual(__test__.parseGitRemoteOutput(""), []);
  });

  test("buildGitRemoteUnavailableMessage 会带上真实报错与当前 git 路径", () => {
    const message = __test__.buildGitRemoteUnavailableMessage(
      "You have not agreed to the Xcode license agreements.",
      "/Library/Developer/CommandLineTools/usr/bin/git",
    );

    assert.match(message, /Xcode license agreements/);
    assert.match(
      message,
      /\/Library\/Developer\/CommandLineTools\/usr\/bin\/git/,
    );
    assert.match(message, /git\.path/);
  });

  test("extractGitFailureReason 优先取 stderr 首个非空行", () => {
    assert.strictEqual(
      __test__.extractGitFailureReason({
        ok: false,
        stdout: "",
        stderr:
          "\nYou have not agreed to the Xcode license agreements.\n请接受许可证",
      }),
      "You have not agreed to the Xcode license agreements.",
    );
    assert.strictEqual(
      __test__.extractGitFailureReason({
        ok: false,
        stdout: "",
        stderr: "",
        errorMessage: "spawn git ENOENT",
      }),
      "spawn git ENOENT",
    );
    assert.strictEqual(__test__.extractGitFailureReason({ ok: false }), "");
  });

  // 回归：历史上 listGitRemotes 用 catch 把“git 执行失败”吞成“没有远端”，
  // 导致用户只看到“已取消推送：未选择远端”，真实报错被完全掩盖。
  test("git 不可用时 readGitRemotes 返回失败原因，而不是空远端列表", async () => {
    const gitConfig = vscode.workspace.getConfiguration("git");
    const originalPath = gitConfig.get<string | null>("path");

    try {
      await gitConfig.update(
        "path",
        "/nonexistent/git-for-reviewstream-test",
        vscode.ConfigurationTarget.Global,
      );

      const result = await __test__.readGitRemotes(process.cwd());

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.ok(
          result.reason.length > 0,
          "应该带上 git 的真实失败原因，而不是空的远端列表",
        );
      }
    } finally {
      await gitConfig.update(
        "path",
        originalPath ?? undefined,
        vscode.ConfigurationTarget.Global,
      );
    }
  });
});

suite("推送前预检", () => {
  const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
  const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

  test("evaluatePushPrecheck：HEAD 已在目标分支时优先报 already-on-branch", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: HEAD_SHA,
        headAlreadyOnBranch: true,
        uncommittedCount: 0,
      }),
      { status: "block", reason: "already-on-branch" },
    );
  });

  test("evaluatePushPrecheck：SHA 未变且有未提交改动时报 uncommitted-changes", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: HEAD_SHA,
        headAlreadyOnBranch: false,
        uncommittedCount: 3,
      }),
      { status: "block", reason: "uncommitted-changes" },
    );
  });

  test("evaluatePushPrecheck：SHA 未变且工作区干净时报 no-new-commit", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: HEAD_SHA,
        headAlreadyOnBranch: false,
        uncommittedCount: 0,
      }),
      { status: "block", reason: "no-new-commit" },
    );
  });

  test("evaluatePushPrecheck：未提交改动数未知时按 no-new-commit 处理", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: HEAD_SHA,
        headAlreadyOnBranch: false,
      }),
      { status: "block", reason: "no-new-commit" },
    );
  });

  test("evaluatePushPrecheck：有真正的新提交时放行", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: OTHER_SHA,
        headAlreadyOnBranch: false,
        uncommittedCount: 12,
      }),
      { status: "ok" },
    );
  });

  test("evaluatePushPrecheck：没有推送记录时放行（宁漏勿误）", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        headAlreadyOnBranch: false,
        uncommittedCount: 5,
      }),
      { status: "ok" },
    );
  });

  test("shortSha 取前 7 位，短 SHA 原样返回", () => {
    assert.strictEqual(__test__.shortSha(HEAD_SHA), "0123456");
    assert.strictEqual(__test__.shortSha("abc"), "abc");
  });

  test("parseUncommittedCount 统计非空行（兼容 CRLF 与空输出）", () => {
    assert.strictEqual(__test__.parseUncommittedCount(""), 0);
    assert.strictEqual(__test__.parseUncommittedCount("\n"), 0);
    assert.strictEqual(
      __test__.parseUncommittedCount(" M a.ts\r\nM  b.ts\r\n"),
      2,
    );
  });
});
