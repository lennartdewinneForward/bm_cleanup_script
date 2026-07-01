import path from 'path';
import fs from 'fs/promises';
import { getBackupConfig, getWebdavConfig } from '../index.js';
import { triggerJobExecution, getJobExecutionStatus, downloadWebdavFile } from '../api/api.js';

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function archiveLocalMetadataBackups({
    outputDir,
    realmIdentifier,
    targetFileName,
    includeTarget = false
}) {
    const safeRealm = String(realmIdentifier || 'unknown').replace(/[^A-Za-z0-9.-]/g, '-');
    const metadataFilePattern = new RegExp(
        `^${escapeRegExp(safeRealm)}_meta_data_backup_\\d{4}-\\d{2}-\\d{2}\\.xml$`
    );

    await fs.mkdir(outputDir, { recursive: true });

    const archiveDir = path.join(outputDir, 'archive');
    await fs.mkdir(archiveDir, { recursive: true });

    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let archivedCount = 0;

    for (const entry of entries) {
        if (!entry.isFile() || !metadataFilePattern.test(entry.name)) {
            continue;
        }

        if (!includeTarget && entry.name === targetFileName) {
            continue;
        }

        const sourcePath = path.join(outputDir, entry.name);
        const ext = path.extname(entry.name);
        const base = path.basename(entry.name, ext);

        let archiveName = entry.name;
        if (entry.name === targetFileName) {
            archiveName = `${base}_${timestamp}${ext}`;
        }

        let destinationPath = path.join(archiveDir, archiveName);
        let suffix = 1;

        while (await pathExists(destinationPath)) {
            destinationPath = path.join(archiveDir, `${base}_${timestamp}_${suffix}${ext}`);
            suffix += 1;
        }

        await fs.rename(sourcePath, destinationPath);
        archivedCount += 1;
    }

    return archivedCount;
}

/**
 * Build a safe file name for metadata backups.
 * Includes the realm identifier (preferably realm name) and current date for traceability.
 * @param {string} realmIdentifier - Realm identifier for naming
 * @returns {string} File name
 */
export function buildMetadataBackupFileName(realmIdentifier) {
    const safeHost = String(realmIdentifier || 'unknown').replace(/[^A-Za-z0-9.-]/g, '-');
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `${safeHost}_meta_data_backup_${date}.xml`;
}

/**
 * Determine whether a job execution has reached a terminal state.
 * SFCC OCAPI returns:
 *   execution_status: "pending" | "running" | "finished" | "aborted"
 *   exit_status:      { status: "ok" | "error" }  (only present when finished)
 *
 * @param {Object} response - OCAPI job execution response
 * @returns {{ done: boolean, ok: boolean }} done=true when terminal; ok=true when successful
 * @private
 */
function resolveJobTerminalState(response) {
    const execStatus = (response.execution_status || response.status || '').toLowerCase();

    // Still running — not terminal
    if (execStatus === 'pending' || execStatus === 'running') {
        return { done: false, ok: false };
    }

    // Aborted — terminal failure
    if (execStatus === 'aborted') {
        return { done: true, ok: false };
    }

    // Finished — check exit_status for success or error
    if (execStatus === 'finished') {
        const exitStatus = typeof response.exit_status === 'object'
            ? (response.exit_status.status || '').toLowerCase()
            : (response.exit_status || '').toLowerCase();

        return { done: true, ok: exitStatus === 'ok' };
    }

    // Unknown status — treat as terminal failure
    return { done: true, ok: false };
}

/**
 * Poll job status until completion or timeout
 * @param {Object} params - Poll parameters
 * @returns {Promise<{status: string, ok: boolean, statusResponse: Object|null}>}
 * @private
 */
async function pollJobStatus(params) {
    const {
        jobId,
        executionId,
        realm,
        ocapiVersion,
        pollIntervalMs,
        timeoutMs
    } = params;
    const pollStart = Date.now();
    let lastLoggedStatus = '';

    while (true) {
        const statusResponse = await getJobExecutionStatus(
            jobId,
            executionId,
            realm,
            ocapiVersion
        );

        if (!statusResponse) {
            return { status: 'ERROR', ok: false, statusResponse: null };
        }

        const rawExecStatus = (statusResponse.execution_status || statusResponse.status || 'unknown').toLowerCase();
        if (rawExecStatus !== lastLoggedStatus) {
            const elapsedMs = Date.now() - pollStart;
            const elapsedSec = Math.round(elapsedMs / 1000);
            const exitStatus = typeof statusResponse.exit_status === 'object'
                ? (statusResponse.exit_status.status || '')
                : (statusResponse.exit_status || '');
            const exitSuffix = exitStatus ? `, exit_status=${exitStatus}` : '';

            console.log(
                `${realm}: job ${jobId} execution ${executionId} status=${rawExecStatus}`
                + `${exitSuffix} (${elapsedSec}s elapsed)`
            );
            lastLoggedStatus = rawExecStatus;
        }

        const terminal = resolveJobTerminalState(statusResponse);

        if (terminal.done) {
            const label = terminal.ok ? 'OK' : 'FAILED';
            return { status: label, ok: terminal.ok, statusResponse };
        }

        if (Date.now() - pollStart >= timeoutMs) {
            return { status: 'TIMEOUT', ok: false, statusResponse };
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
}

/**
 * Try to download the existing metadata XML from WebDAV.
 * If the file doesn't exist on the server, trigger a backup job, wait for it,
 * then download. This means manually-triggered jobs in BM are picked up
 * without needing to re-run the job.
 *
 * @param {string} realm - Realm name
 * @param {string} _instanceType - Instance type (unused, reserved for future use)
 * @param {Object} [options] - Refresh options
 * @param {boolean} [options.forceJobExecution=false] - Force running backup job before download
 * @returns {Promise<{ok: boolean, filePath?: string, status?: string, reason?: string}>}
 */
export async function refreshMetadataBackupForRealm(realm, _instanceType, options = {}) {
    let backupConfig;
    let webdavConfig;
    const forceJobExecution = options.forceJobExecution === true;

    try {
        backupConfig = getBackupConfig();
        webdavConfig = getWebdavConfig(realm);
    } catch (configError) {
        return { ok: false, reason: configError.message };
    }

    const realmIdentifier = webdavConfig.name || webdavConfig.hostname;
    const targetFileName = buildMetadataBackupFileName(realmIdentifier);
    const archiveDir = path.join(backupConfig.outputDir, 'archive');

    try {
        if (forceJobExecution) {
            console.log(`${realm}: force refresh enabled — triggering backup job before download.`);
        }

        if (!forceJobExecution) {
            const archivedBeforeCachedDownload = await archiveLocalMetadataBackups({
                outputDir: backupConfig.outputDir,
                realmIdentifier,
                targetFileName,
                includeTarget: false
            });

            if (archivedBeforeCachedDownload > 0) {
                console.log(
                    `${realm}: archived ${archivedBeforeCachedDownload} old metadata file(s) to ${archiveDir}`
                );
            }

            // --- 1. Try downloading the existing file first ---
            const existingPath = await downloadWebdavFile(
                webdavConfig, backupConfig.outputDir, targetFileName, realm
            );

            if (existingPath) {
                try {
                    await fs.access(existingPath);
                    return { ok: true, filePath: existingPath, status: 'EXISTING' };
                } catch {
                    // Download returned a path but file is missing — fall through
                }
            }
        }

        // --- 2. Trigger backup job (always when forced, otherwise only after cache miss) ---
        if (!backupConfig.jobId) {
            return {
                ok: false,
                reason: forceJobExecution
                    ? 'Cannot force fresh metadata: no backup.jobId configured'
                    : 'No existing metadata file and no backup.jobId configured'
            };
        }

        const executionResponse = await triggerJobExecution(
            backupConfig.jobId,
            realm,
            backupConfig.ocapiVersion
        );

        if (!executionResponse) {
            return { ok: false, reason: 'Failed to trigger backup job' };
        }

        const executionId = executionResponse.id ||
            executionResponse.execution_id ||
            executionResponse.job_execution_id ||
            null;

        if (!executionId) {
            return {
                ok: false,
                reason: 'Missing execution ID from job response'
            };
        }

        console.log(
            `${realm}: triggered backup job '${backupConfig.jobId}' with executionId=${executionId}`
        );

        // --- 3. Poll until job reaches a terminal state ---
        const pollResult = await pollJobStatus({
            jobId: backupConfig.jobId,
            executionId,
            realm,
            ocapiVersion: backupConfig.ocapiVersion,
            pollIntervalMs: backupConfig.pollIntervalMs,
            timeoutMs: backupConfig.timeoutMs
        });

        if (!pollResult.ok) {
            return {
                ok: false,
                reason: `Backup job finished with status: ${pollResult.status}`,
                status: pollResult.status
            };
        }

        const archivedBeforeFreshDownload = await archiveLocalMetadataBackups({
            outputDir: backupConfig.outputDir,
            realmIdentifier,
            targetFileName,
            includeTarget: true
        });

        if (archivedBeforeFreshDownload > 0) {
            console.log(
                `${realm}: archived ${archivedBeforeFreshDownload} old metadata file(s) to ${archiveDir}`
            );
        }

        // --- 4. Download after job completed ---
        const downloadedPath = await downloadWebdavFile(
            webdavConfig, backupConfig.outputDir, targetFileName, realm
        );

        if (!downloadedPath) {
            return {
                ok: false,
                reason: 'Job completed but failed to download metadata XML'
            };
        }

        try {
            await fs.access(downloadedPath);
        } catch {
            return {
                ok: false,
                reason: `Downloaded file not found at ${downloadedPath}`
            };
        }

        return {
            ok: true, filePath: downloadedPath, status: pollResult.status
        };
    } catch (unexpectedError) {
        return {
            ok: false,
            reason: unexpectedError.message || String(unexpectedError)
        };
    }
}

/**
 * Resolve expected metadata backup path for a realm (today's date).
 * @param {string} realm - Realm name
 * @returns {string} Expected metadata file path
 */
export function getMetadataBackupPathForRealm(realm) {
    const backupConfig = getBackupConfig();
    const webdavConfig = getWebdavConfig(realm);
    const fileName = buildMetadataBackupFileName(webdavConfig.name || webdavConfig.hostname);
    return path.join(backupConfig.outputDir, fileName);
}
