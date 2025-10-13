import * as glob from '@actions/glob';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';

import CacheDistributor from './cache-distributor';

class PipenvCache extends CacheDistributor {
  constructor(
    private pythonVersion: string,
    protected patterns: string = '**/Pipfile.lock'
  ) {
    super('pipenv', patterns);
  }

  protected async getCacheGlobalDirectories() {
    let virtualEnvRelativePath;

    // Default virtualenv directories are hardcoded,
    // because pipenv is not preinstalled on hosted images and virtualenv is not created:
    // https://github.com/pypa/pipenv/blob/1daaa0de9a0b00d386c6baeb809d8d4ee6795cfd/pipenv/utils.py#L1990-L2002
    if (process.platform === 'win32') {
      virtualEnvRelativePath = '.virtualenvs';
    } else {
      virtualEnvRelativePath = '.local/share/virtualenvs';
    }
    const resolvedPath = path.join(os.homedir(), virtualEnvRelativePath);
    core.debug(`global cache directory path is ${resolvedPath}`);

    return [resolvedPath];
  }

  /**
   * Determine if a given path is inside the workspace.
   */
  private isInWorkspace(filePath: string, workspace: string): boolean {
    // Normalize both paths
    const resolvedFilePath = path.resolve(workspace, filePath);
    const resolvedWorkspace = path.resolve(workspace);
    return resolvedFilePath.startsWith(resolvedWorkspace);
  }

  protected async computeKeys() {
    const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
    const actionPath = process.env['GITHUB_ACTION_PATH'] || '';

    let roots: string[] = [workspace];
    let allowFilesOutsideWorkspace = false;

    if (!this.isInWorkspace(this.patterns, workspace)) {
      roots = [workspace, actionPath];
      allowFilesOutsideWorkspace = true;
    }

    // Pass workspace and options for advanced globbing/hashing
    const hash = await glob.hashFiles(this.patterns, workspace, {
      roots,
      allowFilesOutsideWorkspace
      // Optionally: exclude: ['*.log']
    });
    const primaryKey = `${this.CACHE_KEY_PREFIX}-${process.env['RUNNER_OS']}-${process.arch}-python-${this.pythonVersion}-${this.packageManager}-${hash}`;
    const restoreKey = undefined;
    return {
      primaryKey,
      restoreKey
    };
  }
}

export default PipenvCache;
